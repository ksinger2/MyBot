// H2 (auth hardening): MUST be required first, before runner.js or anything
// that may spawn child processes. Captures INTERNAL_API_TOKEN into a closure
// and deletes it from process.env so Claude subprocesses can never read it.
const { getInternalToken } = require('./internal-token');
const INTERNAL_API_TOKEN = getInternalToken();
if (INTERNAL_API_TOKEN) {
  const envState = process.env.INTERNAL_API_TOKEN ? 'LEAKED' : 'scrubbed';
  console.log(`[security] bot.js: INTERNAL_API_TOKEN loaded via closure; process.env state: ${envState}`);
}

const { spawn, execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { handleWizardMessage, cancelWizard, startWizard } = require('./wizard');
const { init: initErrorAlerting, sendErrorAlert } = require('./error-alerting');
const { addSchedule, removeSchedule, getUserSchedules, formatScheduleList } = require('./schedules-storage');
const { addMonitor, removeMonitor, listMonitors, getMonitor, updateMonitor } = require('./monitor-config');
const OpenAI = require('openai');
const { startAllSchedules, registerJob, cancelJob } = require('./scheduler');
const { saveChannelState, loadAllChannelStates, flushPendingWrites } = require('./channel-persistence');
const { appendEntry, getJournalContext } = require('./session-journal');
const { loadMemory } = require('./memory');
const { startHeartbeat, stopHeartbeat, getHeartbeatStatus, listHeartbeats, loadStandingOrders } = require('./heartbeat');
const { getSkill, listSkills } = require('./skills/skill-loader');
const { detectLinks, buildExtractionPrompt, buildSmartPrompt, enrichLinks } = require('./link-extractor');
const { startHangoutWizard, processHangoutStep } = require('./wizards/hangout');
const { startTripPlannerWizard, runResearchPhase } = require('./wizards/trip-planner');
let startSocialPlanWizard, processSocialPlanStep;
try { ({ startSocialPlanWizard, processSocialPlanStep } = require('./wizards/social-plan')); } catch {}
let spotifyAuth;
try { spotifyAuth = require('./spotify-auth'); } catch {}
const { Runner, SlotTimeoutError, killOrphanClaude } = require('./runner');
const USE_SDK_RUNNER = process.env.USE_SDK_RUNNER === 'true' || process.env.USE_SDK_RUNNER === '1';
let SDKRunner;
if (USE_SDK_RUNNER) {
  try { ({ SDKRunner } = require('./sdk-runner')); } catch (e) {
    console.warn('[bot] SDK runner failed to load, falling back to CLI runner:', e.message);
  }
}
const { sweepOrphanTmpFiles, atomicWriteJsonSync } = require('./atomic-write');
const { extractImageAttachments } = require('./adapters/base');
const { loadCommands } = require('./commands');
const { addNote, extractNotes, stripNoteTags, getGroupNotes, startReminderLoop } = require('./group-notes');
const { registerFlight, restoreFlightJobs, extractFlightTag, stripFlightTags } = require('./flight-tracker');
const { stopSignalWatchdog } = require('./signal-watchdog');

// F10: Deterministic greeting fast-path — replies without invoking Claude.
// 100% reliable, $0, ~50ms. The system prompt rule stays as a backstop.
const GREETING_RE = /^[\s\p{Emoji}]*(h(i|ey|ello|ola)|yo+|sup|what'?s\s*up|good\s*(morning|evening|afternoon|night)|gm|thanks?|thank\s*you|thx|ty|ok(ay)?|cool|nice|got\s*it|bet|lol|lmao|haha)(\s+(girl|babe|there|bestie|queen|boo|hun|love|dude|man|bro|fam))?\s*[!?.♡❤️✨💕💋😘]*\s*$/iu;
const GREETING_RESPONSES = {
  tiffany_pollard: ["hey boo! 💅", "hiii 😘", "what's good! 💕", "heyyy 💋", "sup girl!", "heyy! ✨"],
  april_ludgate: ["hey", "sup", "hi i guess", "what", "hey."],
  _default: ["Hey! What's up?", "Hi there!", "Hey, what can I help with?", "Hey! 👋"],
};
function _pickGreetingResponse(personality) {
  const pool = GREETING_RESPONSES[personality] || GREETING_RESPONSES._default;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Returns true when a message should skip the grouping buffer and fire immediately.
// Messages that clearly end a thought (punctuation, long) don't need debouncing.
function shouldGroupImmediately(text) {
  if (MESSAGE_GROUP_DELAY_MS === 0) return true;
  const t = (text || '').trim();
  if (/[?!.…]$/.test(t)) return true;
  if (t.length > 60) return true;  // Most single thoughts are complete at 60 chars
  return false;
}

// F15: PII redaction for log output (duplicated from adapters/signal.js to avoid circular dep)
function _redactId(id) {
  if (typeof id !== 'string') return id;
  if (id.startsWith('+')) return id.slice(0, 2) + '****' + id.slice(-2);
  if (id.length >= 12) return id.slice(0, 4) + '...' + id.slice(-4);
  return id;
}

// ── !unlock PIN gate — sudo-style elevation for file mutations ──────────────
// When BOT_UNLOCK_PIN is set, every channel starts in READ-ONLY mode: Claude
// can chat, search the web, access calendars, parse videos, teach, answer
// questions — but cannot Edit/Write/Bash (file-mutating tools are blocked via
// the --allowedTools flag). Users send `!unlock <PIN>` to elevate the channel
// to full write access for the session.
//
// This is NOT a login gate — the bot responds to everyone normally. The PIN
// only gates destructive filesystem operations. Think `sudo`, not login.
//
// When BOT_UNLOCK_PIN is unset, the gate is disabled (everyone gets full access
// as before, subject to the existing owner/allowlist checks).
const BOT_UNLOCK_PIN = process.env.BOT_UNLOCK_PIN || '';
const OWNER_FULL_ACCESS_ENABLED = process.env.OWNER_FULL_ACCESS === 'true' || process.env.OWNER_FULL_ACCESS === '1';
const ELEVATED_FILE = path.join('/app/data', 'elevated-channels.json');
const ELEVATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Load persisted elevations from disk, discarding expired entries
const _elevatedChannels = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(ELEVATED_FILE, 'utf8'));
  const now = Date.now();
  for (const [chId, ts] of Object.entries(raw)) {
    if (now - ts < ELEVATION_TTL_MS) _elevatedChannels.set(chId, ts);
  }
  console.log(`[unlock] Loaded ${_elevatedChannels.size} persisted elevation(s) from disk`);
} catch {}

function _persistElevated() {
  try {
    atomicWriteJsonSync(ELEVATED_FILE, Object.fromEntries(_elevatedChannels));
  } catch (err) {
    console.warn(`[unlock] Failed to persist elevations: ${err.message}`);
  }
}

function _isChannelElevated(channelId) {
  if (!BOT_UNLOCK_PIN) return true; // gate disabled → always elevated
  const ts = _elevatedChannels.get(channelId);
  if (!ts) return false;
  if (Date.now() - ts >= ELEVATION_TTL_MS) {
    _elevatedChannels.delete(channelId);
    _persistElevated();
    console.log(`[unlock] Channel ${channelId} elevation expired (24h)`);
    return false;
  }
  return true;
}

function _tryUnlock(channelId, suppliedPin) {
  if (!BOT_UNLOCK_PIN) return true;
  if (typeof suppliedPin !== 'string' || suppliedPin.length === 0) return false;
  const crypto = require('crypto');
  const a = Buffer.from(BOT_UNLOCK_PIN);
  const b = Buffer.from(suppliedPin);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  _elevatedChannels.set(channelId, Date.now());
  _persistElevated();
  console.log(`[unlock] Channel ${channelId} elevated to full write access (expires in 24h)`);
  return true;
}

const PERSONALITIES_DIR = path.join(__dirname, 'personalities');
const DEFAULT_PERSONALITY = 'tiffany_pollard';
const DEFAULT_WORKSPACE = '/workspace';
const DEFAULT_MAX_TURNS = parseInt(process.env.DEFAULT_MAX_TURNS, 10) || 50;
const MAX_AUTO_CONTINUES = parseInt(process.env.MAX_AUTO_CONTINUES, 10) || 5;
const MAX_TIMEOUT = (parseInt(process.env.MAX_TIMEOUT_MINUTES, 10) || 90) * 60 * 1000;
// Cumulative spend cap per !loop run. Loop bails gracefully when exceeded.
const MAX_LOOP_COST_USD = parseFloat(process.env.MAX_LOOP_COST_USD) || 5;
// Pause between loop iterations (let Discord catch up, give system time to flush).
const LOOP_ITERATION_COOLDOWN_MS = parseInt(process.env.LOOP_ITERATION_COOLDOWN_MS, 10) || 5000;
// M3: hard wallclock ceiling on a single !loop run (defense-in-depth on top of
// per-iteration timeout + cost cap). Prevents a recovering loop from churning
// forever across iterations.
const MAX_LOOP_WALLCLOCK_MS = parseInt(process.env.MAX_LOOP_WALLCLOCK_MS, 10) || (2 * 60 * 60 * 1000); // 2h default
// M3: per-channel daily iteration cap — a runaway loop that keeps recovering
// from errors can't burn through more than this many iterations in a UTC day.
const MAX_LOOP_ITERATIONS_PER_DAY = parseInt(process.env.MAX_LOOP_ITERATIONS_PER_DAY, 10) || 200;

const _rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_SESSIONS = 5;

function _checkRateLimit(userId) {
  const now = Date.now();
  const entry = _rateLimitMap.get(userId);
  if (!entry) {
    _rateLimitMap.set(userId, { timestamps: [now] });
    return true;
  }
  entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (entry.timestamps.length >= RATE_LIMIT_MAX_SESSIONS) return false;
  entry.timestamps.push(now);
  return true;
}

// Message grouping debounce — wait this many ms for follow-up messages before
// dispatching. Set MESSAGE_GROUP_DELAY_MS=0 to disable.
const MESSAGE_GROUP_DELAY_MS = parseInt(process.env.MESSAGE_GROUP_DELAY_MS, 10) || 800;
// Session inactivity timeout — clears sessionId after this many ms of no messages.
// Timer resets on every message and pauses while bot is processing.
const SESSION_INACTIVITY_MS = parseInt(process.env.SESSION_INACTIVITY_MS, 10) || (15 * 60 * 1000);

function _resetSessionInactivityTimer(state, channelId) {
  if (state._sessionInactivityTimer) clearTimeout(state._sessionInactivityTimer);
  if (state.busy) {
    state._sessionInactivityTimer = null;
    return;
  }
  state._sessionInactivityTimer = setTimeout(() => {
    if (state.sessionId && !state.busy) {
      console.log(`[session-expiry] Clearing sessionId for ${channelId} after ${SESSION_INACTIVITY_MS / 60000}min inactivity`);
      if (state.process) {
        console.log(`[session-expiry] Killing orphaned process for ${channelId}`);
        forceKillProcess(state.process, 3000).catch(() => {});
      }
      state.sessionId = null;
      state.sessionStartedAt = null;
      state.sessionTurns = 0;
      state.sessionCost = 0;
      saveChannelState(channelId, state);
    }
    state._sessionInactivityTimer = null;
  }, SESSION_INACTIVITY_MS);
  if (state._sessionInactivityTimer.unref) state._sessionInactivityTimer.unref();
}
// M3: in-memory per-channel iteration counter, keyed by UTC date. Resets on
// day rollover. Map<channelId, { date: 'YYYY-MM-DD', count: number }>.
const _loopIterationsToday = new Map();
function _todayUTC() {
  return new Date().toISOString().slice(0, 10);
}
function _bumpLoopIterationCount(channelId) {
  const today = _todayUTC();
  const entry = _loopIterationsToday.get(channelId);
  if (!entry || entry.date !== today) {
    _loopIterationsToday.set(channelId, { date: today, count: 1 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}
const STALL_THRESHOLDS = {
  thinking: 5 * 60 * 1000,   // 5 min — no tool active, just "thinking"
  bash:     10 * 60 * 1000,  // 10 min — shell commands
  default:  10 * 60 * 1000,  // 10 min — everything else
};
const CHECKIN_INTERVAL = 5 * 60 * 1000; // Progress check-in every 5 minutes
const DEFAULT_IDENTITY = {
  name: 'Bianca',
  description: 'an autonomous AI coding agent on Signal. You build software, orchestrate projects across /workspace/, and execute tasks end-to-end — don\'t ask, just do it.'
};

// Tool labels for !btw progress display
const TOOL_LABELS = {
  Read: 'Reading', Write: 'Writing', Edit: 'Editing',
  Bash: 'Running command', Glob: 'Finding files', Grep: 'Searching code',
  WebSearch: 'Searching web', WebFetch: 'Fetching URL',
  Agent: 'Running sub-agent', Skill: 'Using skill',
};

// Discover available agent types from global ~/.claude/agents/ directory
function loadAvailableAgents() {
  const agentsDir = '/home/node/.claude/agents';
  try {
    if (!fs.existsSync(agentsDir)) return [];
    return fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const content = fs.readFileSync(path.join(agentsDir, f), 'utf-8');
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return null;
        const nameMatch = match[1].match(/^name:\s*(.+)$/m);
        const descMatch = match[1].match(/^description:\s*"?(.+?)"?\s*$/m);
        return nameMatch ? { name: nameMatch[1].trim(), description: descMatch ? descMatch[1].trim() : '' } : null;
      })
      .filter(Boolean);
  } catch { return []; }
}
const AVAILABLE_AGENTS = loadAvailableAgents();

function summarizeToolInput(name, jsonStr) {
  try {
    const input = JSON.parse(jsonStr);
    switch (name) {
      case 'Read': case 'Write': case 'Edit': return input.file_path || '';
      case 'Bash': return (input.command || '').substring(0, 80);
      case 'Glob': return input.pattern || '';
      case 'Grep': return input.pattern || '';
      case 'Agent': return input.description || input.prompt?.substring(0, 60) || 'sub-agent';
      case 'WebSearch': return input.query || '';
      case 'WebFetch': return input.url?.substring(0, 60) || '';
      default: return '';
    }
  } catch { return ''; }
}

function freshProgress() {
  const loopDetection = require('./loop-detection');
  return {
    currentTool: null, toolDetail: '', toolHistory: [], turnCount: 0,
    lastActivity: Date.now(), recentOutputs: [],
    rawLog: [],           // rolling buffer of last 30 terminal-style log lines
    stallWarned: false,   // track whether we've sent a stall warning
    lastLoopWarning: 0,   // cooldown timestamp for loop warnings
    lastLoopWarningKey: '', // dedupe loop warnings by detector+pattern key
    loopState: loopDetection.createState(),  // sliding window for loop-detection.js
    activeAgents: new Map(),  // tool_use_id → { description, startedAt, lastTool, lastDetail }
    completedAgents: [],      // [{ description, completedAt }]
  };
}

function getStallThreshold(currentTool) {
  if (!currentTool) return STALL_THRESHOLDS.thinking;
  if (currentTool === 'Bash') return STALL_THRESHOLDS.bash;
  return STALL_THRESHOLDS.default;
}

/**
 * Gracefully kill a child process: SIGTERM first, then SIGKILL after timeout.
 * Returns a Promise that resolves when the process is confirmed dead.
 */
function forceKillProcess(proc, timeoutMs = 3000) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    proc.once('exit', done);
    proc.kill('SIGTERM');
    setTimeout(() => {
      try { process.kill(proc.pid, 0); proc.kill('SIGKILL'); } catch {}
      setTimeout(done, 1000);
    }, timeoutMs);
  });
}

/**
 * ChannelProxy — platform-agnostic wrapper for sending messages back to the user.
 * Used by askClaude, runClaudeWithContinuation, stall detector, etc.
 * Works identically for Discord channels and Signal conversations.
 */
class ChannelProxy {
  constructor({ sendFn, typingFn, platform = 'discord', chatId = null }) {
    this._sendFn = sendFn;
    this._typingFn = typingFn || (() => Promise.resolve());
    this.platform = platform;
    this.chatId = chatId;
  }

  async send(content) {
    try {
      const text = typeof content === 'string' ? content : (content?.content || content?.toString() || '');
      if (!text) return;
      return await this._sendFn(text);
    } catch (err) {
      console.error(`[${this.platform}] ChannelProxy send error:`, err.message);
    }
  }

  async sendTyping() {
    try { await this._typingFn(); } catch {}
  }

  /** Create a ChannelProxy for a Signal conversation */
  static fromSignal(adapter, recipientChatId) {
    // Collect image paths stripped from streamed text so we can attach them
    // after the session ends — they can't be sent inline during streaming.
    const _strippedImagePaths = [];

    const proxy = new ChannelProxy({
      sendFn: (text) => {
        // Strip any image file paths before sending — they attach separately.
        let cleaned = (text || '').replace(/\/tmp\/[^\s"'`\n]+\.(?:png|jpg|jpeg|webp)/gi, (match) => {
          const p = match.trim();
          if (p && !_strippedImagePaths.includes(p)) _strippedImagePaths.push(p);
          return '';
        });
        // Strip all system tags before they reach the user (they get processed post-session)
        cleaned = cleaned.replace(/\[(IMAGINE|LEARNED|NOTE|RESOLVE_NOTE|UPDATE_NOTES|CONCERT_PRICES|FLIGHT_SEARCH|FLIGHT_PRICE|EIGHTSLEEP|FLIGHT|WEATHER|CALENDAR|PRODUCT|EMAIL_UNSUB|CART_ADD):\s*[^\]]*\]/gi, '').trim();
        if (!cleaned) return Promise.resolve();
        return adapter.sendMessage(recipientChatId, cleaned);
      },
      typingFn: () => Promise.resolve(),
      platform: 'signal',
      chatId: recipientChatId,
    });

    // Expose collected paths so the signal handler can send them as attachments
    proxy.strippedImagePaths = _strippedImagePaths;
    return proxy;
  }
}

function pushRawLog(progress, entry) {
  const elapsed = Math.round((Date.now() - (progress._startTime || Date.now())) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  progress.rawLog.push({ ts, text: entry });
  if (progress.rawLog.length > 50) progress.rawLog.shift();
}

// Push a line to recentOutputs, keeping only the last 15
function pushOutput(progress, line) {
  if (!line) return;
  const trimmed = line.length > 200 ? line.substring(0, 197) + '...' : line;
  progress.recentOutputs.push(trimmed);
  if (progress.recentOutputs.length > 15) progress.recentOutputs.shift();
}

function buildAuditPrompt(focus = 'full', cwd = DEFAULT_WORKSPACE) {
  const projectName = path.basename(cwd);
  const agentSections = {
    design: `### Design Agent
**Role:** lead-designer
**Focus:** Visual consistency, spacing, typography, colors, dark mode support, responsive layout, accessibility (WCAG), component states (hover, focus, disabled, error), animation/transitions.`,
    product: `### Product Agent
**Role:** principal-product-manager
**Focus:** Feature completeness vs requirements/CLAUDE.md, user flows end-to-end, empty states, loading states, error states, copy/microcopy review, onboarding experience.`,
    qa: `### QA Agent
**Role:** qa-engineer + manual-qa-tester
**Focus:** Click every button, test every form, submit edge cases (empty, too long, special chars, SQL injection strings), check console for errors, test navigation flows, verify all links, screenshot every bug found.`,
    security: `### Security Agent
**Role:** backend-lead-engineer
**Focus:** Input validation/sanitization, authentication/authorization, XSS/CSRF/injection vulnerabilities, secrets in code or logs, \`npm audit\` / dependency vulnerabilities, API security (rate limiting, CORS), environment variable handling.`,
    analytics: `### Analytics Agent
**Role:** data-scientist
**Focus:** Event tracking coverage (are key actions tracked?), event naming consistency, funnel instrumentation (signup, purchase, etc.), privacy compliance (PII in events, consent), analytics initialization and error handling.`,
    performance: `### Performance Agent
**Role:** principal-engineer
**Focus:** Bundle size analysis, render performance, unnecessary re-renders, network call count and payload sizes, caching strategy, image optimization, lazy loading, lighthouse score if web.`,
  };

  const selectedAgents = focus === 'full'
    ? Object.values(agentSections).join('\n\n')
    : agentSections[focus] || Object.values(agentSections).join('\n\n');

  const focusLabel = focus === 'full' ? 'full audit (all categories)' : `${focus}-focused audit`;

  return `# PROJECT AUDIT MODE — ${projectName}

You are running a **${focusLabel}** of \`${cwd}\`.

## AUDIT MODE RULES (override normal autonomy)

1. **PROPOSE BEFORE ACTING** — Present your plan and findings, then STOP and wait for the user's approval before making any code changes. Do NOT auto-fix anything.
2. **COST GATING** — If any action costs money (image generation, API calls, paid services), list the estimated costs and WAIT for explicit consent before proceeding.
3. **ASK QUESTIONS** — If you need clarification about project intent, expected behavior, or priorities, ASK. Don't assume.
4. **ITERATE UNTIL DONE** — After fixes, re-audit the fixed areas. Don't declare victory after one pass. Keep going until clean.
5. **SCREENSHOTS MANDATORY** — Use Playwright to take screenshots of every finding. Visual evidence for everything.

---

## Phase 1: Discovery (run immediately — no approval needed)

1. Read CLAUDE.md, NextSteps.md, package.json, and key project files to understand the project
2. Determine: tech stack, build commands, how to run the project, entry points
3. Build and launch the project (follow build instructions from CLAUDE.md)
4. Use Playwright to navigate every screen/page/route you can find:
   - Take **desktop screenshots** (1280×800 viewport)
   - Take **mobile screenshots** using viewport emulation:
     - iPhone 14: 390×844 viewport
     - Pixel 7: 412×915 viewport
5. Present to the user:
   - **Project summary** (stack, structure, entry points)
   - **Screens found** (list with screenshot references)
   - **Proposed audit plan** (which agents will run, what they'll check)
   - **Questions** (anything unclear about the project)
   - **Cost estimates** (if any actions will cost money)

**⛔ STOP HERE. Wait for user approval before proceeding to Phase 2.**

---

## Phase 2: Parallel Agent Review (after user approves Phase 1)

Launch ALL of the following agents IN PARALLEL (use the Agent tool, one per agent):

${selectedAgents}

Each agent must:
- Take Playwright screenshots of every issue found
- Document: location, expected behavior, actual behavior, severity (Critical/High/Medium/Low)
- Be thorough — check EVERY screen, EVERY component, EVERY state

### Mobile Testing
Use Playwright viewport emulation for responsive testing:
- iPhone 14: \`page.setViewportSize({ width: 390, height: 844 })\`
- Pixel 7: \`page.setViewportSize({ width: 412, height: 915 })\`
Do NOT use native simulators — viewport emulation only.

---

## Phase 3: Issue Compilation

After all agents complete:
1. Compile ALL findings into a single prioritized table:

| # | Category | Severity | Location | Description | Screenshot |
|---|----------|----------|----------|-------------|------------|

2. Group by category (Design, Product, QA, Security, Analytics, Performance)
3. Sort by severity within each category (Critical → Low)
4. Include screenshot paths for every issue

**⛔ STOP HERE. Present the full issue table and wait for user to approve which issues to fix.**

---

## Phase 4: Fix Execution (after user approves which issues to fix)

1. Plan the fixes — group related issues into batches
2. Present the fix plan briefly (which files, what changes)
3. Get approval, then implement using parallel agents where possible
4. After each batch:
   - Rebuild the project
   - Re-test the fixed areas
   - Take verification screenshots (before → after)

---

## Phase 5: Verification

1. Re-audit ALL areas that were fixed
2. Present before/after screenshots for each fix
3. If new issues are discovered → go back to Phase 3 with the new findings
4. Continue until all approved fixes are verified clean

---

## Phase 6: Final Report

Present a final summary:
- **Found:** X issues across Y categories
- **Fixed:** X issues
- **Deferred:** X issues (with reasons)
- **Screenshot gallery:** Before/after for all fixes
- **Remaining recommendations:** Anything not addressed
- Update NextSteps.md with audit results
- Commit all changes with a descriptive message

Begin Phase 1 now.`;
}

// ── Startup markers — read ONCE, consumed immediately ───────────────────────
// Prevents the race condition where Discord and Signal both read/delete the
// same marker files independently. Both platforms now reference these pre-
// computed values instead of calling fs.existsSync() themselves.
const _startupMarkers = (() => {
  const cleanFile = path.join('/home/node/.claude', '.clean-shutdown');
  const rebuildFile = path.join('/home/node/.claude', '.rebuild-marker');
  const rolledBackFile = '/tmp/.rolled-back';
  const wasClean = fs.existsSync(cleanFile);
  const wasRebuild = fs.existsSync(rebuildFile);
  const wasRolledBack = fs.existsSync(rolledBackFile);
  // Consume markers immediately so they fire only once regardless of startup order
  if (wasClean) try { fs.unlinkSync(cleanFile); } catch {}
  if (wasRebuild) try { fs.unlinkSync(rebuildFile); } catch {}
  if (wasRolledBack) try { fs.unlinkSync(rolledBackFile); } catch {}
  return { wasClean, wasRebuild, wasRolledBack };
})();

// ── Auto-allowlist: track identifiers seen in shared Signal groups ───────────
// If someone is in a group with the bot, they're trusted enough to DM the bot
// (e.g., after typing !setup in a group). Persisted to survive rebuilds.
// Stores BOTH phone numbers AND UUIDs because the same user's senderId can
// differ between contexts (phone in group, UUID in DM, or vice versa).
const KNOWN_GROUP_MEMBERS_FILE = path.join('/app/data', 'known-group-members.json');
const _knownGroupMembers = new Set();
try {
  const _kgmRaw = JSON.parse(fs.readFileSync(KNOWN_GROUP_MEMBERS_FILE, 'utf8'));
  if (Array.isArray(_kgmRaw)) _kgmRaw.forEach(n => _knownGroupMembers.add(n));
} catch {}
function _addKnownGroupMember(identifier) {
  if (!identifier || _knownGroupMembers.has(identifier)) return;
  _knownGroupMembers.add(identifier);
  try { atomicWriteJsonSync(KNOWN_GROUP_MEMBERS_FILE, [..._knownGroupMembers]); } catch {}
}
// Add both phone AND UUID for a group member so DMs match regardless of format
function _addKnownGroupMemberFull(msg) {
  if (msg.senderId) _addKnownGroupMember(msg.senderId);
  // Also add the raw UUID and phone from the envelope if available
  if (msg._senderUuid) _addKnownGroupMember(msg._senderUuid);
  if (msg._senderPhone) _addKnownGroupMember(msg._senderPhone);
}

// Per-channel state
const channels = new Map();

// Graceful shutdown — kill children, persist state, then exit
async function gracefulShutdown(signal) {
  console.log(`[shutdown] Received ${signal}, killing children and persisting state...`);
  try { stopSignalWatchdog(); } catch {}
  const killPromises = [];
  for (const [channelId, state] of channels) {
    if (state.process) killPromises.push(forceKillProcess(state.process, 3000));
    if (state._bgTasks) {
      for (const [taskId, task] of state._bgTasks) {
        if (task._channelState?.process) killPromises.push(forceKillProcess(task._channelState.process, 3000));
      }
    }
    if (state.busy && state.activeTask) {
      saveChannelState(channelId, state);
    }
  }
  // Wait for all children to die (5s safety cap)
  await Promise.race([
    Promise.all(killPromises),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  flushPendingWrites();
  // Write clean-shutdown marker so the next boot doesn't send a crash notification.
  // This covers both !restart (which already wrote it) and docker compose stop/rebuild
  // (which sends SIGTERM but previously had no marker).
  try { fs.writeFileSync(path.join('/home/node/.claude', '.clean-shutdown'), Date.now().toString()); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

function getChannel(channelId) {
  if (!channels.has(channelId)) {
    // Check for persisted state from previous container lifecycle
    const saved = _savedChannelStates?.[channelId];
    channels.set(channelId, {
      _channelId: channelId, // stored for journal lookups
      sessionId: saved?.sessionId || null,
      personality: saved?.personality || DEFAULT_PERSONALITY,
      identity: (saved?.identity && saved.identity.name && saved.identity.name !== 'My Bot') ? { ...saved.identity } : { ...DEFAULT_IDENTITY },
      cwd: saved?.cwd || DEFAULT_WORKSPACE,
      config: saved?.config || {},  // per-channel overrides (maxTurns, maxContinues, maxTimeout)
      listenToAll: saved?.listenToAll || false, // when true, respond to all group messages (not just mentions)
      process: null,  // active child process
      busy: false,    // is Claude currently working
      wizard: null,   // active wizard state (multi-step interactions)
      startedAt: null, // timestamp when Claude started working
      progress: freshProgress(), // structured progress for !btw
      queue: (saved?.pendingQueue || []).map(text => ({ content: text, timestamp: Date.now() })),
      recentMessages: saved?.recentMessages || [], // recent messages for context persistence (capped at 20)
      groupingTimer: null,   // debounce timer for message grouping
      groupingBuffer: [],    // buffered messages waiting to be combined
      groupingSenderId: null, // sender of the buffered messages
      _triggeredByTimestamp: null, // Signal timestamp of the message that started the active task
      _sessionInactivityTimer: null, // 15-min timer that clears sessionId on expiry
      sessionStartedAt: saved?.sessionStartedAt || null,
      sessionTurns: saved?.sessionTurns || 0,
      sessionCost: saved?.sessionCost || 0,
    });
  }
  return channels.get(channelId);
}

// Loaded once on startup, used by getChannel to merge saved state
let _savedChannelStates = null;

function getChannelState(channelId) {
  return getChannel(channelId);
}

function getPersonalityFile(name) {
  const file = path.join(PERSONALITIES_DIR, `${name}.md`);
  return fs.existsSync(file) ? file : null;
}

function listPersonalities() {
  return fs.readdirSync(PERSONALITIES_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));
}

function askClaude(prompt, { sessionId = null, personalityFile = null, identity = null, cwd = DEFAULT_WORKSPACE, maxTurns = null, channelState = null, channelProxy = null, discordUserId = null, readOnly = false, groupAllowedTools = undefined, profileContext = null, streamReplies = false, model = 'sonnet', ownerDmMode = false, planMode = false, isVoice = false, isOwner = false, recentMessages = null } = {}) {
  const runnerOpts = {
    sessionId, personalityFile, identity, cwd, maxTurns,
    channelState, channelProxy, discordUserId, readOnly,
    groupAllowedTools, profileContext, streamReplies, model, ownerDmMode, planMode, isVoice,
    isOwner, recentMessages,
    freshProgressFn: freshProgress,
    saveChannelStateFn: saveChannelState,
    flushPendingWritesFn: flushPendingWrites,
  };

  const RunnerClass = (USE_SDK_RUNNER && SDKRunner) ? SDKRunner : Runner;
  const runner = new RunnerClass(prompt, runnerOpts);
  return runner.run();
}

async function runClaudeWithContinuation(prompt, opts, channelProxy) {
  let result = await askClaude(prompt, opts);

  // Rate-limit retry: if the CLI was genuinely killed by throttling, wait and
  // resume silently. Up to 2 retries with 60s backoff — no user-facing messages
  // unless all retries are exhausted.
  const MAX_RATE_RETRIES = 2;
  let rateRetries = 0;
  while (result.rateLimited && rateRetries < MAX_RATE_RETRIES) {
    rateRetries++;
    await new Promise(r => setTimeout(r, 60_000 * rateRetries));
    result = await askClaude(
      'Continue where you left off.',
      { ...opts, sessionId: result.sessionId }
    );
  }

  let continueCount = 0;
  let totalCost = result.cost || 0;
  let totalTurns = result.numTurns || 0;
  let anyStreamed = !!result.streamed;
  const maxContinues = opts.channelState?.config?.maxContinues || MAX_AUTO_CONTINUES;

  // Don't auto-continue in group chats (short tasks, noisy for non-technical users)
  const isGroupContext = opts.channelState?._isGroupChat;

  // Owner DM parity mode runs without a turn cap (maxTurns=1000 in runner.js),
  // so hitTurnLimit should never fire. If it does, respect the natural end —
  // don't spin up the auto-continue / NextSteps.md checkpoint machinery, which
  // is designed for the shorter capped sessions.
  const skipAutoContinue = !!opts.ownerDmMode;

  // Context refresh: every REFRESH_EVERY continuations, save progress to NextSteps.md,
  // end the session, and start fresh. Prevents context bloat and stale-loop issues.
  const REFRESH_EVERY = 3;

  while (result.hitTurnLimit && continueCount < maxContinues && !result.stopped && !isGroupContext && !skipAutoContinue) {
    continueCount++;
    const isOwnerDm = opts.channelState && !opts.channelState._isGroupChat;

    // Checkpoint & restart: save to NextSteps.md → kill session → fresh start
    if (continueCount % REFRESH_EVERY === 0 && continueCount < maxContinues) {
      if (isOwnerDm) {
        await channelProxy.send(
          `*Context refresh (${continueCount}/${maxContinues}) — saving progress and restarting with clean context...*`
        ).catch(() => {});
      }
      // Step 1: Tell Claude to save progress
      try {
        const saveResult = await askClaude(
          'CHECKPOINT: Update NextSteps.md NOW with your current progress — what you accomplished, what\'s working, what\'s broken, and specific next steps to continue. Bullet points only, be concise. This is a mid-task checkpoint.',
          { ...opts, sessionId: result.sessionId, maxTurns: 2 }
        );
        totalCost += saveResult.cost || 0;
        totalTurns += saveResult.numTurns || 0;
        if (saveResult.streamed) anyStreamed = true;
      } catch {}
      // Step 2: Start fresh session (no sessionId — runner.js auto-injects NextSteps.md + CLAUDE.md)
      result = await askClaude(
        'Continue working on the current task. Check NextSteps.md for context on where you left off. Do NOT re-trigger any rebuild or restart actions mentioned there — those were already handled. Focus on the original user request. If the task is complete, say DONE.',
        { ...opts } // NO sessionId = fresh context
      );
    } else {
      // Normal continuation within the same session
      if (isOwnerDm) {
        await channelProxy.send(
          `*Turn limit reached (${continueCount}/${maxContinues}) — auto-continuing...*`
        ).catch(() => {});
      }
      result = await askClaude(
        'You hit the turn limit. Continue where you left off. If the task is complete, say DONE and do not add anything else.',
        { ...opts, sessionId: result.sessionId }
      );
    }
    totalCost += result.cost || 0;
    totalTurns += result.numTurns || 0;
    if (result.streamed) anyStreamed = true;
  }

  if (result.hitTurnLimit && continueCount >= maxContinues && !skipAutoContinue) {
    // Final handoff turn — ensure NextSteps.md is updated
    try {
      const handoff = await askClaude(
        'You have reached the turn limit. This is your LAST turn. Update NextSteps.md with: what you accomplished, what is working, what is broken, and specific next steps. Be concise — bullet points only.',
        { ...opts, sessionId: result.sessionId, maxTurns: 1 }
      );
      totalCost += handoff.cost || 0;
      totalTurns += handoff.numTurns || 0;
      result = { ...handoff, cost: totalCost, numTurns: totalTurns };
    } catch {}
    await channelProxy.send(
      `*Reached max auto-continuations (${maxContinues}). Session handed off via NextSteps.md. Send another message to keep going.*`
    ).catch(() => {});
  }

  return { ...result, cost: totalCost, numTurns: totalTurns, streamed: anyStreamed };
}

// extractImageAttachments imported from adapters/base.js (F8/F22)

// Signal-only sendLongMessage. `message` is a Signal proxy created via
// createSignalMessageProxy() — its `_signalChatId` field is the recipient.
// Image attachments embedded in the response text are sent as attachments
// after the text body via signalAdapter.sendMessage.
async function sendLongMessage(message, text, cwd = DEFAULT_WORKSPACE) {
  if (!text || text.length === 0) return;

  const chatId = message?._signalChatId
    || (message?.channel?.id ? String(message.channel.id).replace(/^signal:/, '') : null);
  if (!chatId || !signalAdapter) {
    console.warn('[sendLongMessage] no Signal chatId or adapter; dropping message');
    return;
  }

  // Resolve relative paths against cwd before scanning for image attachments
  const resolvedText = text.replace(/(?:^|\s)([\w./][^\s"'`()]*\.(?:png|jpg|jpeg|gif|webp))/gim, (m, p) => {
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    return m.replace(p, abs);
  });
  const imagePaths = extractImageAttachments(resolvedText);

  // Strip image paths from the text — images go as separate attachments
  let textToSend = text;
  for (const imgPath of imagePaths) {
    textToSend = textToSend.replace(imgPath, '').trim();
  }

  if (textToSend) {
    await signalAdapter.sendLongMessage(chatId, textToSend).catch(e =>
      console.error('[sendLongMessage] Signal send failed:', e.message));
  }

  for (const imgPath of imagePaths) {
    try {
      const buf = fs.readFileSync(imgPath);
      await signalAdapter.sendMessage(chatId, '', {
        attachments: [buf],
        attachmentNames: [path.basename(imgPath)],
      });
    } catch (e) {
      console.error(`[sendLongMessage] Could not send image ${imgPath}: ${e.message}`);
    }
  }
}

/**
 * Parse natural-language frequency into a cron expression
 * Supports: "daily at 9am", "every 2 hours", "weekdays at 8:30am", "monday at 10am", raw cron
 */
const { parseFrequency } = require('./parse-frequency');

// ── Command dispatch ──────────────────────────────────────────────────────────
// Commands are loaded from claude-api/commands/*.js. Each exports
// { name, aliases?, adminOnly?, description, run(message, arg, state, ctx) }.
// The ctx object passes bot.js internals to command handlers.

const commands = loadCommands();

// Signal-only reply helper — sends `text` back to the chat that produced
// `message`. Works with the proxy objects created by createSignalMessageProxy().
async function _sreply(message, text) {
  if (!signalAdapter || !text) return null;
  const chatId = message?._signalChatId
    || (message?.channel?.id ? String(message.channel.id).replace(/^signal:/, '') : null);
  if (!chatId) return null;
  try { return await signalAdapter.sendMessage(chatId, text); }
  catch (e) { console.warn('[_sreply] send failed:', e.message); return null; }
}

async function _styping(message) {
  if (!signalAdapter) return;
  const chatId = message?._signalChatId
    || (message?.channel?.id ? String(message.channel.id).replace(/^signal:/, '') : null);
  if (!chatId) return;
  try { await signalAdapter.sendTyping(chatId); } catch {}
}

function buildCommandCtx() {
  return {
    // Channel state
    channels, getChannel, saveChannelState, flushPendingWrites,
    // Messaging helpers
    sendLongMessage, ChannelProxy,
    // Claude invocation
    askClaude, runClaudeWithContinuation,
    // Process management
    forceKillProcess, freshProgress, processQueue,
    // Personality & identity
    getPersonalityFile, listPersonalities,
    // Error alerting
    sendErrorAlert,
    // Scheduling & schedules
    addSchedule, removeSchedule, getUserSchedules, formatScheduleList,
    registerJob, cancelJob, parseFrequency,
    startWizard, cancelWizard,
    // Monitors
    addMonitor, removeMonitor, listMonitors, getMonitor, updateMonitor,
    // Heartbeat & standing orders
    startHeartbeat, stopHeartbeat, getHeartbeatStatus, loadStandingOrders,
    // Skills
    getSkill, listSkills,
    // Audit prompt builder
    buildAuditPrompt,
    // Wizards
    startHangoutWizard, startTripPlannerWizard,
    // Signal
    get signalAdapter() { return signalAdapter; },
    // Spotify (optional)
    spotifyAuth,
    // Workspace
    listWorkspaceDirs, DEFAULT_WORKSPACE,
    // Loop-related constants & helpers
    MAX_LOOP_COST_USD, LOOP_ITERATION_COOLDOWN_MS,
    MAX_LOOP_WALLCLOCK_MS, MAX_LOOP_ITERATIONS_PER_DAY,
    _bumpLoopIterationCount,
    // Config constants
    DEFAULT_MAX_TURNS, MAX_AUTO_CONTINUES, MAX_TIMEOUT,
    STALL_THRESHOLDS, CHECKIN_INTERVAL,
    // Progress display
    TOOL_LABELS,
    // Signal messaging helpers (replaces former _dsend/_dreply/_dtyping)
    _sreply, _styping,
    // Back-compat aliases so any command still using these names keeps working.
    _dsend: (_msgOrCh, text) => _sreply(_msgOrCh, text),
    _dreply: (msg, text) => _sreply(msg, text),
    _dtyping: (msgOrCh) => _styping(msgOrCh),
  };
}

// Lazy-initialized — built once on first use so that all bot.js globals
// (including signalAdapter which is set up later) are captured.
let _commandCtx = null;
function getCommandCtx() {
  if (!_commandCtx) _commandCtx = buildCommandCtx();
  return _commandCtx;
}

async function handleCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  const cmdName = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();
  const state = getChannel(message.channel.id);

  const cmd = commands.get(cmdName);
  if (!cmd) return false;

  // Gate admin-only commands. Signal messages go through a proxy that sets
  // `_signalSenderId`; admin = `isSignalOwner(senderId)`.
  if (cmd.adminOnly) {
    const { isSignalOwner } = require('./project-permissions');
    const isAdminCaller = message._signalSenderId
      ? isSignalOwner(message._signalSenderId)
      : false;
    if (!isAdminCaller) {
      await _sreply(message, 'Owner only — that command requires admin access.');
      return true;
    }
  }

  await cmd.run(message, arg, state, getCommandCtx());
  return true;
}

function listWorkspaceDirs() {
  try {
    return fs.readdirSync(DEFAULT_WORKSPACE)
      .filter(e => {
        try { return fs.statSync(path.join(DEFAULT_WORKSPACE, e)).isDirectory(); }
        catch { return false; }
      })
      .map(e => `  📁 ${e}/`)
      .join('\n') || '(empty)';
  } catch {
    return '(cannot read /workspace)';
  }
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  sendErrorAlert(err instanceof Error ? err : new Error(String(err)), { source: 'unhandledRejection' });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  sendErrorAlert(err, { source: 'uncaughtException' });
});

// Idempotency guard — startBot() may be called from the Signal adapter's
// .start().then() and ALSO from a fallback in start() if the adapter never
// comes online. Run the body at most once.
let _startBotRan = false;
async function startBot() {
  if (_startBotRan) return;
  _startBotRan = true;

  // Kill orphan claude CLI processes from previous container runs
  try { killOrphanClaude(); } catch (err) { console.warn(`[startup] orphan cleanup failed: ${err.message}`); }

  // F16: sweep orphaned .tmp files from previous crash before reading stores
  try { sweepOrphanTmpFiles(['/app/data', '/home/node/.claude']); } catch {}

  // F17: boot warnings for hardcoded fallbacks
  if (!process.env.HOST_HOME) console.warn('[security] WARNING: HOST_HOME not set — rebuild flow may use wrong home directory. Set HOST_HOME in .env.');
  if (!process.env.SIGNAL_OWNER_NUMBER) console.warn('[security] WARNING: SIGNAL_OWNER_NUMBER not set in .env — falling back to hardcoded default. Set SIGNAL_OWNER_NUMBER in .env.');

  console.log(`Default personality: ${DEFAULT_PERSONALITY}`);
  console.log(`Workspace: ${DEFAULT_WORKSPACE}`);
  console.log(`Max turns: ${DEFAULT_MAX_TURNS} | Timeout: ${MAX_TIMEOUT / 60000}min`);
  if (BOT_UNLOCK_PIN) {
    console.log('[security] !unlock PIN gate is ACTIVE — channels start read-only (chat/search/browse OK, file edits blocked). Send !unlock <PIN> to elevate.');
  } else {
    console.log('[security] !unlock PIN gate is disabled (BOT_UNLOCK_PIN not set).');
  }
  console.log(`[security] Owner full-access mode is ${OWNER_FULL_ACCESS_ENABLED ? 'ENABLED' : 'DISABLED'}${OWNER_FULL_ACCESS_ENABLED ? ' — Claude may use privileged engineering tools in owner DM.' : ' — owner DM stays in restricted agent mode unless OWNER_FULL_ACCESS=true.'}`);

  // Restore persisted channel states from previous container lifecycle
  _savedChannelStates = loadAllChannelStates();
  // After a rebuild, clear all session IDs so conversations start fresh.
  // Stale sessions contain the pre-rebuild conversation history which can
  // include instructions like "rebuild" that cause infinite rebuild loops.
  if (_startupMarkers.wasRebuild) {
    for (const state of Object.values(_savedChannelStates)) {
      if (state.sessionId) {
        console.log(`[rebuild] Clearing stale sessionId for fresh start`);
        state.sessionId = null;
      }
    }
  }
  const savedCount = Object.keys(_savedChannelStates).length;
  if (savedCount > 0) {
    console.log(`Restored ${savedCount} channel state(s) from persistence`);
    // Pre-populate channels Map so !status shows them
    for (const channelId of Object.keys(_savedChannelStates)) {
      getChannel(channelId);
    }
  }

  // Notify channel if we're coming back from a !restart. The .restart-channel
  // file holds a Signal channelId of the form `signal:<chatId>`.
  const restartFile = path.join(__dirname, '.restart-channel');
  if (fs.existsSync(restartFile)) {
    try {
      const channelId = fs.readFileSync(restartFile, 'utf-8').trim();
      fs.unlinkSync(restartFile);
      if (channelId.startsWith('signal:') && signalAdapter) {
        const chatId = channelId.replace(/^signal:/, '');
        signalAdapter.sendMessage(chatId, "I'm back! Restart complete.").catch(() => {});
      }
    } catch {}
  }

  // Initialize error alerting (Signal-only)
  initErrorAlerting(signalAdapter);

  // Use pre-computed startup markers (read once at module load).
  const wasRolledBack = _startupMarkers.wasRolledBack;
  const wasCleanShutdown = _startupMarkers.wasClean;

  if (wasRolledBack) {
    sendErrorAlert(new Error('Automatic rollback triggered — bot crash-looped after a rebuild and was restored to the last known good version. The bad code changes are still in /workspace/MyBot/claude-api/ and need to be fixed.'));
    console.log('[entrypoint] Recovered from crash loop via automatic rollback');
  }

  // After crash-loop rollback, clear all active tasks (the task may have caused the crash)
  if (wasRolledBack) {
    for (const channelId of Object.keys(_savedChannelStates)) {
      if (_savedChannelStates[channelId].activeTask) {
        _savedChannelStates[channelId].activeTask = null;
        const s = getChannel(channelId);
        s.activeTask = null;
        saveChannelState(channelId, s);
      }
    }
    flushPendingWrites();
  }

  // P1-B: Startup reconciliation between user-profiles.json and token stores.
  // If a profile claims a provider is connected but no token exists (stale flag
  // left behind by a failed removeUser / lost token file / manual edit), clear
  // the flag so the UI and prompts don't advertise a connection we can't serve.
  try {
    const userProfilesMod = require('./user-profiles');
    const userTokensMod = require('./user-tokens');
    let spotifyTokensMod = null;
    try { spotifyTokensMod = require('./spotify-tokens'); } catch {}

    const allProfiles = userProfilesMod.getAllProfiles();
    let reconciled = 0;
    for (const [phone, profile] of Object.entries(allProfiles)) {
      const patch = {};
      if (profile.gcal_connected && !userTokensMod.getToken(phone)) {
        patch.gcal_connected = false;
        patch.gcal_email = null;
      }
      if (profile.spotify_connected && spotifyTokensMod && !spotifyTokensMod.getToken(phone)) {
        patch.spotify_connected = false;
      }
      if (Object.keys(patch).length > 0) {
        userProfilesMod.setProfile(phone, patch);
        reconciled++;
      }
    }
    console.log(`[startup] reconciliation: ${reconciled} profile(s) reconciled`);
  } catch (err) {
    console.warn(`[startup] reconciliation failed: ${err.message}`);
  }

  // Start scheduled briefings
  const briefings = require('./briefings');
  briefings.startScheduler();

  // Start AI news pulse (every 3 hours)
  const aiNews = require('./ai-news');
  aiNews.startAINewsScheduler();

  // Seed media pulse job for Signal owner (first boot only — editable via setup page)
  const { seedMediaPulse } = require('./media-pulse-seed');
  const mediaPulseSeed = seedMediaPulse();
  if (mediaPulseSeed) {
    try { const { registerJob } = require('./scheduler'); registerJob(mediaPulseSeed); } catch {}
  }

  // Start user-created schedules
  startAllSchedules();

  // Start background task queue runner
  const { startQueueRunner } = require('./queue-runner');
  startQueueRunner();

  // Start event monitors (CI, health checks)
  const { startMonitorRunner } = require('./monitor-runner');
  startMonitorRunner();

  // Auto-resume interrupted work after a crash (not a clean !restart).
  // Signal-only: every channelId is `signal:<chatId>`.
  if (!wasCleanShutdown && !wasRolledBack) {
    setTimeout(() => {
      const channelsToNotify = Object.entries(_savedChannelStates).filter(([, s]) => {
        if (!s) return false;
        if (s.activeTask) return true;
        if (s.pendingQueue && s.pendingQueue.length > 0) return true;
        return false;
      });
      if (channelsToNotify.length === 0) return;
      console.log(`[auto-resume] Found ${channelsToNotify.length} channel(s) needing restart notification`);

      const resumePromises = channelsToNotify.map(([channelId, savedState]) => resumeChannel(channelId, savedState));
      Promise.allSettled(resumePromises).then(results => {
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        console.log(`[auto-resume] Done: ${succeeded} notified, ${failed} failed`);
      });
    }, 5000);
  }
}

async function resumeChannel(channelId, savedState) {
  const task = savedState.activeTask;
  const state = getChannel(channelId);

  // Build the restart notification message.
  function buildRestartMessage() {
    const wantsNotice = savedState.wantsRestartNotification;
    const queueLen = (savedState.pendingQueue || []).length;
    const taskSummary = task?.prompt ? task.prompt.substring(0, 100) : null;
    const summary =
      taskSummary ||
      wantsNotice?.summary ||
      (queueLen > 0 ? `${queueLen} queued message${queueLen === 1 ? '' : 's'}` : null);

    if (wantsNotice?.reason === 'rebuild') {
      return summary
        ? `Back online — I just rebuilt myself. Mid-rebuild I was working on: "${summary}". If anything you sent didn't get answered, resend it now.`
        : `Back online — I just rebuilt myself. If anything you sent didn't get answered, resend it now.`;
    }
    return summary
      ? `I'm back from an unexpected restart. I was working on: "${summary}" — that got interrupted. Resend if you still need it.`
      : `I'm back from an unexpected restart. Anything you sent in the last few minutes may have been dropped — resend if you still need it.`;
  }

  // Signal-only: every channelId we persist is prefixed `signal:`.
  if (!channelId.startsWith('signal:')) {
    console.warn(`[auto-resume] Skipping non-signal channelId ${channelId}`);
    return;
  }

  const signalChatId = channelId.replace(/^signal:/, '');
  state.activeTask = null;
  state.busy = false;
  state.wantsRestartNotification = null;
  saveChannelState(channelId, state, { critical: true });

  if (signalAdapter && signalAdapter.ready) {
    signalAdapter.sendMessage(signalChatId, buildRestartMessage()).catch(err => {
      console.warn(`[auto-resume] Could not notify Signal channel ${channelId}: ${err.message}`);
    });
    console.log(`[auto-resume] Notified Signal channel ${channelId} of restart`);
  } else {
    console.log(`[auto-resume] Signal adapter not ready, skipping notification for ${channelId}`);
  }
}

// Signal-only: drain any queued messages for this channel state.
// Items in state.queue are: { content, message?, _messageId? } where `message`
// is a Signal proxy created via createSignalMessageProxy().
async function processQueue(state) {
  if (!state.queue.length) return;

  // CRITICAL: Set busy BEFORE splicing to prevent race with incoming messages
  state.busy = true;

  const queued = state.queue.splice(0);
  const combined = queued.length === 1
    ? queued[0].content
    : '[Additional messages from user while you were working]\n' + queued.map(q => `- ${q.content}`).join('\n');

  const replyTarget = queued[queued.length - 1].message;
  // Resolve signal chatId — strip `signal:` prefix if present.
  const channelId = state._channelId || replyTarget?._signalChatId
    ? (state._channelId || `signal:${replyTarget._signalChatId}`)
    : null;
  const signalChatId = replyTarget?._signalChatId
    || (channelId ? channelId.replace(/^signal:/, '') : null);

  if (!signalChatId || !signalAdapter) {
    console.warn('[processQueue] No Signal chatId or adapter; dropping queued messages');
    state.busy = false;
    return;
  }

  const personalityFile = getPersonalityFile(state.personality);

  // Detect ownership/group from the signalChatId so queued messages route
  // through the same OAuth/model path as the original dispatch. Without this,
  // queued owner messages fall through to the ANTHROPIC_API_KEY path and fail
  // with "Credit balance too low" because the env key has no credits.
  const { isSignalOwner } = require('./project-permissions');
  const isGroupChatQ = !signalChatId.startsWith('+');
  const senderIsOwnerQ = !isGroupChatQ && isSignalOwner(signalChatId);
  const ownerDmModeQ = senderIsOwnerQ && !isGroupChatQ;

  await signalAdapter.sendTyping(signalChatId).catch(() => {});
  const typingInterval = setInterval(() => {
    signalAdapter.sendTyping(signalChatId).catch(() => {});
  }, 8000);

  try {
    state.startedAt = Date.now();
    state.progress = freshProgress();

    let result;
    const queueOpts = {
      sessionId: state.sessionId,
      personalityFile,
      identity: state.identity,
      cwd: state.cwd,
      channelState: state,
      isOwner: senderIsOwnerQ,
      ownerDmMode: ownerDmModeQ,
      model: ownerDmModeQ ? 'claude-opus-4-7' : 'sonnet',
      maxTurns: ownerDmModeQ ? null : 20,
      streamReplies: true,
      readOnly: false,
      groupAllowedTools: isGroupChatQ ? 'Read,WebSearch,WebFetch,Task,TodoWrite' : undefined,
    };
    try {
      result = await runClaudeWithContinuation(combined, queueOpts, null);
    } catch (err) {
      if (state.sessionId && (err.message?.includes('No conversation found') || err.message?.includes('session'))) {
        console.log('Session resume failed in queue, retrying fresh:', err.message);
        state.sessionId = null;
        state.sessionStartedAt = null; state.sessionTurns = 0; state.sessionCost = 0;
        queueOpts.sessionId = null;
        result = await runClaudeWithContinuation(combined, queueOpts, null);
      } else {
        throw err;
      }
    }
    // Graceful session resume failure from runner
    if (result.sessionResumeFailed) {
      console.log('[session-resume] Queue: graceful retry without session');
      state.sessionId = null;
      state.sessionStartedAt = null; state.sessionTurns = 0; state.sessionCost = 0;
      queueOpts.sessionId = null;
      result = await runClaudeWithContinuation(combined, queueOpts, null);
    }
    // Auth failure during queue processing
    if (result.authFailed) {
      const signalChatIdForAuth = replyTarget?._signalChatId || (channelId ? channelId.replace(/^signal:/, '') : null);
      if (signalChatIdForAuth && signalAdapter) {
        await signalAdapter.sendMessage(signalChatIdForAuth, '⚠️ Not logged in — Claude CLI needs re-authentication. Run `claude` on the host and use `/login` to refresh the token.').catch(() => {});
      }
      return;
    }

    if (result.sessionId) {
      state.sessionId = result.sessionId;
      if (!state.sessionStartedAt) state.sessionStartedAt = Date.now();
      if (channelId) saveChannelState(channelId, state);
    }
    state.sessionTurns += (result.numTurns || 0);
    state.sessionCost += (result.cost || 0);

    // Cost guardrail
    const qMaxCost = state.config?.maxSessionCost;
    if (qMaxCost && state.sessionCost >= qMaxCost) {
      await signalAdapter.sendMessage(signalChatId,
        `💰 Session cost cap reached ($${state.sessionCost.toFixed(4)} / $${qMaxCost.toFixed(2)}). Session cleared.`
      ).catch(() => {});
      state.sessionId = null;
      state.sessionStartedAt = null; state.sessionTurns = 0; state.sessionCost = 0;
      if (channelId) saveChannelState(channelId, state, { critical: true });
    }

    if (result.stopped) {
      if (!state._userStopped) {
        await signalAdapter.sendMessage(signalChatId, 'Process was interrupted unexpectedly — I stopped without finishing. Send another message to continue.').catch(() => {});
      }
      state._userStopped = false;
    } else {
      if (channelId) {
        appendEntry(channelId, {
          cwd: state.cwd,
          promptSummary: combined,
          resultSummary: result.text,
          turnCount: result.numTurns || 0,
        });
      }
      await sendLongMessage(replyTarget, result.text, state.cwd);

      const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
      const completedProgress = state.progress;
      if (result.numTurns >= 3 || elapsed > 60) {
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const parts = [];
        if (mins > 0) parts.push(`${mins}m ${secs}s`);
        else parts.push(`${secs}s`);
        if (result.numTurns) parts.push(`${result.numTurns} turns`);
        if (result.cost) parts.push(`$${result.cost.toFixed(4)}`);
        const toolCounts = {};
        for (const t of completedProgress.toolHistory) {
          const tName = typeof t === 'string' ? t : t.name;
          toolCounts[tName] = (toolCounts[tName] || 0) + 1;
        }
        const topTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([t, c]) => `${c} ${TOOL_LABELS[t] || t}`).join(', ');
        if (topTools) parts.push(topTools);
        await signalAdapter.sendMessage(signalChatId, `— ${parts.join(' · ')} —`).catch(() => {});
      }

      const meta = [];
      if (result.numTurns > 1) meta.push(`${result.numTurns} turns`);
      if (result.cost) meta.push(`$${result.cost.toFixed(4)}`);
      if (meta.length) console.log(`Queue completed: ${meta.join(' | ')}`);
    }
  } catch (err) {
    console.error('Error processing queued message:', err.message);
    const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
    await signalAdapter.sendMessage(signalChatId, `Error: ${errorMsg}`).catch(() => {});
    sendErrorAlert(err, { source: 'queue handler', channel: channelId });
  } finally {
    clearInterval(typingInterval);
    state.busy = false;
    state.startedAt = null;
    state.progress = freshProgress();
    state.activeTask = null;
    if (channelId) {
      saveChannelState(channelId, state, { critical: true });
    }
    // Recursively drain if more messages came in during processing
    await processQueue(state);
  }
}


// --- Signal adapter integration ---

let signalAdapter = null;
// Cache group member lookups to avoid an HTTP round-trip on every message.
// Keyed by group chatId, value: { members: [...], name, fetchedAt }.
const _groupInfoCache = new Map();
const _GROUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function startSignalAdapter() {
  const phoneNumber = process.env.SIGNAL_PHONE_NUMBER;
  if (!phoneNumber) return;

  const { SignalAdapter } = require('./adapters/signal');
  signalAdapter = new SignalAdapter({
    apiUrl: process.env.SIGNAL_API_URL || 'http://signal-api:8080',
    phoneNumber,
    pollInterval: parseInt(process.env.SIGNAL_POLL_INTERVAL, 10) || 5000,
  });
  // Mutate module.exports so late `require('./bot').signalAdapter` (used by
  // the /signal/webhook receiver in server.js) sees the actual instance.
  // The destructured `signalAdapter` in `module.exports = {..., signalAdapter}`
  // below captures `null` at module load time.
  module.exports.signalAdapter = signalAdapter;

  // Track the bot's last sent message timestamp per channel so reaction handlers
  // Track the last N bot message timestamps per channel so 👍/👎 reactions
  // on any recent message (not just the absolute last) get handled correctly.
  // Cost footers, queue confirmations etc. overwrite _lastBotTimestamp and would
  // silently drop reactions to the real content message — tracking a set fixes this.
  const _origSignalSend = signalAdapter.sendMessage.bind(signalAdapter);
  signalAdapter.sendMessage = async function(chatId, text, opts) {
    const result = await _origSignalSend(chatId, text, opts);
    if (result && result.id) {
      const state = channels.get(`signal:${chatId}`) || channels.get(chatId);
      if (state) {
        const ts = Number(result.id) || null;
        state._lastBotTimestamp = ts;
        // Rolling window of last 30 outbound messages keyed by timestamp with
        // text snapshot — reaction handler looks up the original message so
        // 👍/👎 dispatches carry real context instead of a naked "yes"/"no".
        if (!state._recentBotMessages) state._recentBotMessages = [];
        if (ts != null) {
          state._recentBotMessages.push({ ts, text: typeof text === 'string' ? text : '' });
          if (state._recentBotMessages.length > 30) state._recentBotMessages.shift();
        }
      }
    }
    return result;
  };

  // Access control for Signal — comma-separated phone numbers.
  // SECURITY (H1): fail-closed. Empty = deny all (except the owner, who is
  // always permitted via isSignalOwner). Previously empty = allow all, which
  // meant a misconfigured .env exposed the bot to every Signal number on Earth.
  const allowedNumbers = new Set((process.env.SIGNAL_ALLOWED_NUMBERS || '').split(',').filter(Boolean));
  if (allowedNumbers.size === 0) {
    console.warn('[security] WARNING: SIGNAL_ALLOWED_NUMBERS is empty — only the owner and known group members will be allowed to DM the bot. Set SIGNAL_ALLOWED_NUMBERS in .env to permit additional numbers.');
  }

  // Known group members loaded at module level — see _addKnownGroupMember()

  const { isSignalOwner, hasProjectPermission } = require('./project-permissions');
  const { buildProfileContext, getProfile } = require('./user-profiles');

  signalAdapter.on('message', async (msg) => {
    // Resolve UUID→phone early so all downstream code uses a stable phone-based identity.
    // Newer Signal clients omit sourceNumber, so msg.senderId may be a UUID.
    if (msg.senderId && !msg.senderId.startsWith('+')) {
      const resolved = signalAdapter._resolveRecipient(msg.senderId);
      if (resolved && resolved.startsWith('+')) {
        msg.senderId = resolved;
      }
    }

    // Access control — SECURITY (H1): fail-closed. Owner is ALWAYS allowed
    // (even if SIGNAL_ALLOWED_NUMBERS is empty), otherwise must be explicitly
    // listed. Group messages are allowed if the sender is in the allowlist.
    // Access control: owner is always allowed. For non-owners:
    // - GROUP messages: always allowed (if you're in the group, you're trusted)
    // - DM messages: must be in SIGNAL_ALLOWED_NUMBERS (fail-closed for strangers)
    // This lets group members interact with the bot without being individually
    // allowlisted, while still blocking random DMs from unknown numbers.
    const isGroupMessage = msg.chatId !== msg.senderId;
    // Track group members for auto-allowlist — store ALL known identifiers
    // (phone, UUID, senderId) so DMs match regardless of which format signal-cli uses
    if (isGroupMessage) {
      _addKnownGroupMember(msg.senderId);
      // Also store the raw UUID and phone from the envelope if available
      const _rawEnv = msg.raw?.envelope || msg.raw;
      if (_rawEnv?.sourceUuid) _addKnownGroupMember(_rawEnv.sourceUuid);
      if (_rawEnv?.sourceNumber) _addKnownGroupMember(_rawEnv.sourceNumber);
    }
    const senderAllowed = isSignalOwner(msg.senderId) || isGroupMessage
      || allowedNumbers.has(msg.senderId) || _knownGroupMembers.has(msg.senderId);
    if (!senderAllowed) {
      console.log(`[signal] blocked DM from non-allowlisted sender ${_redactId(msg.senderId)}`);
      return;
    }

    // Send read receipt so the sender sees blue double-check on Signal.
    // Best-effort, fire-and-forget — don't block message handling.
    // GROUP MESSAGES: skip entirely. The adapter's _isGroupId guard checks
    // whether the RECIPIENT (the sender's phone) is a group id, which never
    // fires — so without this check the bot was sending individual read
    // receipts to every group member, which Signal surfaces as "Bianca read
    // your message" in the group UI. Fail-closed at the call site.
    if (!isGroupMessage) {
      signalAdapter.sendReadReceipt(msg.senderId, msg.timestamp).catch(() => {});
    }

    // Build a synthesized text body that includes attachment file paths so
    // Claude can Read them. The user reported that images sent over Signal
    // were silently dropped — this is the fix: we hand Claude the local
    // path that the adapter just downloaded.
    // Replace U+FFFC (object replacement character) with the actual mention name.
    // Signal inserts ￼ as a placeholder for @mentions in the text body, with the
    // real name/UUID in the separate mentions array. Without this, "@Merrisa" becomes
    // a blank space and Claude sees "Do  and I" instead of "Do @Merrisa and I".
    let text = msg.text || '';
    const mentions = msg.mentions || [];
    if (mentions.length > 0) {
      // Replace each U+FFFC with the mention name (iterate in reverse to preserve positions)
      // Include ALL mentions, even those without name/number — we'll resolve them
      const sortedMentions = [...mentions].sort((a, b) => (b.start || 0) - (a.start || 0));
      for (const m of sortedMentions) {
        let name = m.name || null;
        // If no name, try resolving UUID → phone → profile name
        if (!name && m.number && m.number.startsWith('+')) {
          const p = getProfile(m.number);
          if (p && p.name) name = p.name;
          else name = m.number;
        }
        if (!name && m.uuid) {
          // Try signal-cli profile name cache (works even without phone number)
          name = signalAdapter?.resolveUuidToName?.(m.uuid) || null;
          // Also try UUID→phone→profile
          if (!name) {
            const resolved = signalAdapter?._resolveRecipient?.(m.uuid);
            if (resolved && resolved.startsWith('+')) {
              m.number = resolved;
              const p = getProfile(resolved);
              name = p?.name || resolved;
            }
          }
        }
        if (!name) name = 'someone';
        m.name = name; // persist the resolved name on the mention object
        text = text.substring(0, m.start || 0) + '@' + name + text.substring((m.start || 0) + (m.length || 1));
      }
    }
    // Strip any remaining U+FFFC that wasn't matched to a mention
    text = text.replace(/\uFFFC/g, '').trim();
    // Also replace raw @UUID patterns that some Signal clients embed directly in text
    text = text.replace(/@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi, (match, uuid) => {
      // Try signal-cli profile name cache first (works for contacts without phone numbers)
      const cachedName = signalAdapter?.resolveUuidToName?.(uuid);
      if (cachedName) return '@' + cachedName;
      // Try UUID→phone→profile
      const resolved = signalAdapter?._resolveRecipient?.(uuid);
      if (resolved && resolved.startsWith('+')) {
        const p = getProfile(resolved);
        return '@' + (p?.name || resolved);
      }
      // Try matching against mentions array
      const m = mentions.find(m => m.uuid === uuid);
      if (m?.name) return '@' + m.name;
      return match;
    });
    const downloadedFiles = (msg.attachments || []).filter(a => a.localPath);
    // Voice message detection: transcribe audio attachments via Whisper
    let isVoiceMessage = false;
    const audioAttachments = downloadedFiles.filter(a => a.type && a.type.startsWith('audio/'));
    if (audioAttachments.length > 0 && !text) {
      // Pure voice message (no accompanying text) — transcribe it
      try {
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const audioPath = audioAttachments[0].localPath;
        console.log(`[voice] Transcribing voice message: ${audioPath}`);
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(audioPath),
          model: 'whisper-1',
          response_format: 'text',
        });
        const transcript = (typeof transcription === 'string' ? transcription : transcription.text || '').trim();
        if (transcript) {
          text = transcript;
          isVoiceMessage = true;
          console.log(`[voice] Transcribed: "${transcript.substring(0, 100)}"`);
        }
      } catch (err) {
        console.error(`[voice] Whisper transcription failed: ${err.message}`);
        await signalAdapter.sendMessage(msg.chatId, `Couldn't understand that voice message — try again?`).catch(() => {});
        return;
      }
    }
    if (downloadedFiles.length > 0 && !isVoiceMessage) {
      const fileList = downloadedFiles
        .map(a => `- ${a.localPath} (${a.type}${a.size ? `, ${a.size} bytes` : ''})`)
        .join('\n');
      const fileBlock = `[The user attached ${downloadedFiles.length} file(s). Read or analyze them with the Read/Bash tools as needed:]\n${fileList}`;
      text = text ? `${text}\n\n${fileBlock}` : fileBlock;
    }
    if (!text) return; // truly empty (no text, no attachments)

    // Owner flag — only +16315214787 can edit code or change permissions
    const senderIsOwner = isSignalOwner(msg.senderId);

    // Use sender's phone number as chatId for per-conversation state.
    // For 1:1 DMs the chatId IS the sender's phone. For groups the chatId is
    // the group's base64 internal ID. We use a per-sender state key for
    // wizards (so onboarding tracks per-person, not per-group).
    const chatId = `signal:${msg.chatId}`;

    // Deterministic image context: register image attachments in the per-chatId
    // registry so /imagine auto-injects them regardless of what Claude passes.
    // Must be after chatId is declared.
    if (downloadedFiles.length > 0) {
      const imageFiles = downloadedFiles.filter(a => a.type && a.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        const imageRegistry = require('./image-registry');
        imageRegistry.setInput(chatId, imageFiles[0].localPath);
      }
    }
    const state = getChannel(chatId);

    // Auto-onboard new Signal users: if we don't have a profile for this phone
    // number AND they're messaging in a 1:1 (not a group), kick off the
    // conversational onboarding wizard. We avoid running it in groups because
    // multi-step wizards over a group chat are confusing for everyone else.
    // Owner is skipped (already known). Group members get profile-less
    // responses until they DM the bot directly to onboard.
    // (isGroupMessage already declared above in the access control block)

    // In Signal group chats, only respond when the bot is @mentioned or it's a !command.
    // Mirrors the Discord guild behaviour (line ~3341). !commands bypass this so group
    // admin tasks still work without an @mention.
    //
    // signal-cli mention objects can identify the mentioned account by EITHER
    // phone number OR UUID — sometimes both, sometimes only one. We match
    // against both forms (the adapter's own number, and its UUID if known).
    if (isGroupMessage && !text.startsWith('!')) {
      // Check per-chat listenToAll toggle — if on, skip the mention check
      // NOTE: use the same prefixed key used for all Signal state (signal:${chatId})
      // Also skip if this sender has a pending onboarding wizard — they need to reply
      const hasPendingSenderWizard = state.senderWizards && state.senderWizards[msg.senderId];
      const mentionList = (msg.mentions && msg.mentions.length > 0)
        ? msg.mentions
        : (msg.raw?.envelope?.dataMessage?.mentions || []);
      const botPhone = signalAdapter.phoneNumber;
      const botUuid = signalAdapter._selfUuid || null;
      const botMentioned = mentionList.some(m =>
        (m.number && m.number === botPhone) ||
        (m.uuid && botUuid && m.uuid === botUuid)
      );

      if (!state.listenToAll && !hasPendingSenderWizard) {
        if (!botMentioned) {
          console.log(`[signal] Group message — bot not mentioned, ignoring (${mentionList.length} other mention(s))`);
          return;
        }
      }

      // Even in listenToAll mode: if the message is ADDRESSING another person
      // directly (imperative verb directed at them), skip. But if it mentions
      // someone in the context of a request to the bot ("@Merrisa wants to join"),
      // don't skip — fall through so Claude can handle it.
      if (state.listenToAll && !botMentioned && mentionList.length > 0) {
        // Strip U+FFFC placeholders AND any literal @Name text Signal may include
        const textWithoutMentions = text
          .replace(/\uFFFC/g, '')
          .replace(/@\w[\w\s]*/g, '')  // strip @Name patterns
          .trim().toLowerCase();
        // Skip if ADDRESSING the mentioned person (2nd-person directed-at):
        //   imperatives, 2nd-person requests, trailing "pls/please" with no task content
        // Keep if talking ABOUT the mentioned person to the bot (3rd-person):
        //   "wants to join", "is coming", "would like to", "needs to be added"
        const isAddressingOther =
          /^(say|go|come|check|look|tell|do|get|send|show|ask|reply|answer|respond|introduce|hi|hey|hello|wave|lol|haha|omg|nice|wow|ok|okay|sure|thanks|thank)\b/.test(textWithoutMentions) ||
          /^(can u|can you|could u|could you|would u|would you|do u|do you|are you|will you|wanna|want to|you should|u should)\b/.test(textWithoutMentions) ||
          /^(please |plz |pls )\b/.test(textWithoutMentions) ||
          textWithoutMentions.length === 0; // message was ONLY the @mention
        // Also skip if the stripped text ends with "pls"/"please" and has no 3rd-person verb
        const thirdPersonVerb = /\b(wants?|is|has|would like|needs?|going|trying|asked|said|told|mentioned)\b/.test(textWithoutMentions);
        if (isAddressingOther && !thirdPersonVerb) {
          console.log(`[signal] Group listenToAll — message addressing another person, ignoring`);
          return;
        }
        // 3rd-person mention (talking ABOUT someone to the bot) — fall through to Claude
      }

      // Even in listenToAll mode: if the message is clearly a short conversational
      // exchange not addressed to the bot (no question, no task, no bot name), skip.
      // Owner always bypasses this filter — they set up listenToAll and should always get responses.
      if (state.listenToAll && !botMentioned && mentionList.length === 0 && !senderIsOwner) {
        const botName = (state.identity?.name || '').toLowerCase();
        const textLower = text.toLowerCase().replace(/\uFFFC/g, '').trim();
        const hasQuestion = textLower.includes('?');
        const hasTask = /\b(can you|could you|please|remind|schedule|search|find|look up|what|who|when|where|how|tell me|do you|help|show|get|check|track|set|add|list|commands|u have|u know)\b/i.test(textLower);
        const namesMeByName = botName && textLower.includes(botName);
        if (!hasQuestion && !hasTask && !namesMeByName) {
          console.log(`[signal] Group listenToAll — short conversational message, not directed at bot, ignoring`);
          return;
        }
      }
    }

    // Store UUID→profile link so group context builder can resolve this user by
    // UUID even when the adapter's in-memory/disk UUID→phone cache has no entry.
    // This fires on every message from a known phone number that also carries a UUID.
    const incomingUuid = msg.raw?.envelope?.sourceUuid;
    if (incomingUuid && msg.senderId && msg.senderId.startsWith('+')) {
      const { saveSignalUuid } = require('./user-profiles');
      if (saveSignalUuid) saveSignalUuid(msg.senderId, incomingUuid);
    }

    // F10: Deterministic greeting fast-path — $0, ~50ms, 100% reliable.
    // Fires BEFORE onboarding, busy-check, link detection, or Claude invocation.
    // Strip U+FFFC (object replacement character) — Signal inserts this as a
    // placeholder for @mentions in the text body. Without stripping, "hey ￼"
    // fails GREETING_RE and falls through to Claude for a 60s+ rate-limited run.
    const rawSignalText = (msg.text || '').replace(/\uFFFC/g, '').trim();
    if (rawSignalText.length < 50 && GREETING_RE.test(rawSignalText) && !rawSignalText.startsWith('!')) {
      const personality = state.personality || DEFAULT_PERSONALITY;
      const greeting = _pickGreetingResponse(personality);
      await signalAdapter.sendMessage(msg.chatId, greeting);
      return;
    }

    if (!senderIsOwner && !isGroupMessage && msg.senderId && msg.senderId.startsWith('+')) {
      const existing = getProfile(msg.senderId);
      const alreadyOnboarded = existing?.setup_complete;
      // Only kick off the wizard once per session, and only if they don't have
      // a complete profile AND there's no wizard already running for them.
      if (!alreadyOnboarded && !state.wizard && !text.startsWith('!')) {
        const { buildOnboardingWizard } = require('./wizards/onboarding');
        const fakeMessage = createSignalMessageProxy(msg, chatId, state);
        try {
          await startWizard(state, fakeMessage, buildOnboardingWizard());
        } catch (err) {
          console.warn(`[signal] onboarding wizard kickoff failed: ${err.message}`);
        }
        return; // The wizard's first prompt has been sent — wait for the user's reply
      }
    }

    // If a wizard is active for this sender or chat, let it consume the message.
    // Per-sender wizards (from !onboard) only activate for that specific phone number.
    // If senderId is a UUID, also check if the resolved phone number has a wizard
    // (the wizard was keyed by phone number from !onboard, but the sender may arrive
    // as a UUID if their phone isn't in the contacts cache yet).
    let wizardSenderId = msg.senderId;
    if (state.senderWizards && !state.senderWizards[msg.senderId] && msg.senderId && !msg.senderId.startsWith('+')) {
      // Try resolving UUID to phone via adapter
      const resolved = signalAdapter._resolveRecipient(msg.senderId);
      if (resolved && resolved.startsWith('+') && state.senderWizards[resolved]) {
        wizardSenderId = resolved;
      }
    }
    const hasSenderWizard = state.senderWizards && state.senderWizards[wizardSenderId];
    if (state.wizard || hasSenderWizard) {
      const fakeMessage = createSignalMessageProxy(msg, chatId, state);
      // If we resolved a different senderId for the wizard, override the proxy
      if (wizardSenderId !== msg.senderId) fakeMessage._signalSenderId = wizardSenderId;
      // Allow !cancel to explicitly escape the wizard (announces cancellation).
      if (text.toLowerCase() === '!cancel') {
        await cancelWizard(state, fakeMessage);
        return;
      }
      // Any OTHER !command also escapes — silently cancel the wizard and
      // fall through to the command router below. This fixes the bug
      // where a stuck wizard (from a prior broken run) would eat every
      // subsequent command the user typed, making !concerts, !product,
      // !prices etc. appear to do nothing.
      // We check the raw text (after stripping mention prefix and
      // attachment-note bleed) so the detection is consistent with the
      // command router's own parsing below.
      const cmdPeek = text.replace(/^@\S+\s+/, '').replace(/\n?\[The user attached \d+ file\(s\)[\s\S]*$/, '').trim();
      if (cmdPeek.startsWith('!')) {
        console.log(`[signal] command "${cmdPeek.split(/\s/)[0]}" arrived during active wizard — silently cancelling wizard`);
        await cancelWizard(state, fakeMessage, { silent: true });
        // Fall through to command router below. Do NOT return here.
      } else {
        // Normal wizard message consumption (plain text or wizard-expected input)
        try {
          const handled = await handleWizardMessage(state, fakeMessage);
          if (handled) return;
        } catch (err) {
          console.error(`[signal] wizard error: ${err.message}`);
          state.wizard = null;
          if (state.senderWizards) delete state.senderWizards[msg.senderId];
          await signalAdapter.sendMessage(msg.chatId, `Wizard error: ${err.message.substring(0, 200)}. Cancelled.`);
          return;
        }
      }
    }

    // Handle commands (same !command syntax).
    // Also handle "@BotName !command" — strip the @mention prefix first.
    // Strip the injected [The user attached...] block so it doesn't leak into command args.
    const cmdText = text.replace(/^@\S+\s+/, '').replace(/\n?\[The user attached \d+ file\(s\)[\s\S]*$/, '').trim();
    if (cmdText.startsWith('!')) {
      const fakeMessage = createSignalMessageProxy({ ...msg, text: cmdText }, chatId, state);
      const handled = await handleCommand(fakeMessage);
      if (handled) return;
    }

    // If busy, queue the message — silently in group chats, brief ack in DMs.
    // Reset inactivity timer — a queued message still counts as activity.
    if (state.busy) {
      _resetSessionInactivityTimer(state, chatId);
      const fakeMessage = createSignalMessageProxy(msg, chatId, state);
      if (state.queue.length >= 10) {
        state.queue.shift();
      }
      state.queue.push({ message: fakeMessage, content: text, _timestamp: msg.timestamp });
      saveChannelState(chatId, state, { critical: true });
      if (!isGroupMessage) {
        const pos = state.queue.length;
        await signalAdapter.sendMessage(msg.chatId, `Queued (#${pos}) — I'll get to that next.`);
      }
      return;
    }

    // Message grouping debounce — buffer rapid follow-up messages from the same user
    if (MESSAGE_GROUP_DELAY_MS > 0 && !shouldGroupImmediately(text)) {
      const userId = msg.senderId;
      // Different user flushing: immediately fire previous buffer
      if (state.groupingTimer && state.groupingSenderId && state.groupingSenderId !== userId) {
        clearTimeout(state.groupingTimer);
        state.groupingTimer = null;
        const prev = state.groupingBuffer.splice(0);
        state.groupingSenderId = null;
        if (prev.length > 0) {
          const combined = prev.map(e => e.content).join('\n');
          setImmediate(() => {
            state._triggeredByTimestamp = prev[prev.length - 1].msg?.timestamp;
            _dispatchSignalMessage(prev[prev.length - 1].msg, prev[prev.length - 1].chatId, combined, state).catch(err => {
              console.error('[signal] dispatch error (flush):', err.message);
            });
          });
        }
      }
      if (!state.groupingBuffer) state.groupingBuffer = [];
      state.groupingBuffer.push({ content: text, msg, chatId });
      state.groupingSenderId = userId;
      if (state.groupingTimer) clearTimeout(state.groupingTimer);
      state.groupingTimer = setTimeout(() => {
        const buf = state.groupingBuffer.splice(0);
        state.groupingTimer = null;
        state.groupingSenderId = null;
        if (buf.length === 0) return;
        const combined = buf.map(e => e.content).join('\n');
        state._triggeredByTimestamp = buf[buf.length - 1].msg?.timestamp;
        state._isVoiceMessage = isVoiceMessage;
        _dispatchSignalMessage(buf[buf.length - 1].msg, buf[buf.length - 1].chatId, combined, state).catch(err => {
          console.error('[signal] dispatch error (debounce):', err.message);
        });
      }, MESSAGE_GROUP_DELAY_MS);
      return;
    }
    // Immediate path (ends with punctuation or long message)
    state._triggeredByTimestamp = msg.timestamp;
    state._isVoiceMessage = isVoiceMessage;
    _dispatchSignalMessage(msg, chatId, text, state).catch(err => {
      console.error('[signal] dispatch error (immediate):', err.message);
    });
  });

  // Handle Signal emoji reactions — treat 👍/👎 as yes/no answers
  signalAdapter.on('reaction', ({ chatId, senderId: rawSenderId, emoji, targetTimestamp, isRemove }) => {
    if (isRemove) return; // ignore reaction removals

    // Resolve UUID→phone for downstream profile/access control lookups
    let senderId = rawSenderId;
    if (senderId && !senderId.startsWith('+')) {
      const resolved = signalAdapter._resolveRecipient(senderId);
      if (resolved && resolved.startsWith('+')) {
        senderId = resolved;
      }
    }

    // Strip skin-tone modifiers (U+1F3FB–1F3FF) so 👍🏼 matches 👍
    const baseEmoji = emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '').trim();
    let answer = null;
    if (baseEmoji === '👍') answer = 'yes';
    else if (baseEmoji === '👎') answer = 'no';
    if (!answer) return;

    const signalChatId = `signal:${chatId}`;
    const state = getChannel(signalChatId);

    // Access control — same rules as regular messages
    const isGroupMessage = chatId !== senderId;
    const senderAllowed = isSignalOwner(senderId) || isGroupMessage || allowedNumbers.has(senderId);
    if (!senderAllowed) {
      console.log(`[signal] Reaction from non-allowlisted sender ${senderId} — ignored`);
      return;
    }

    if (state.busy) {
      console.log(`[signal] Reaction ${emoji} from ${senderId} ignored — channel busy`);
      return;
    }

    // Only act if the reaction targets one of the bot's recent messages.
    // Rolling window (30) of outbound messages keyed by timestamp.
    // CRITICAL: reject any reaction that isn't a confirmed hit on a bot
    // message — previously the check was `length > 0 && !hit`, which
    // silently dispatched a naked "yes"/"no" whenever the cache was empty
    // (right after container restart, or in chats where Bianca hadn't
    // sent anything recently). That meant thumbs-ups on OTHER group
    // members' messages would trigger Bianca responses. The fix: no hit,
    // no dispatch.
    const recent = state._recentBotMessages || [];
    const hit = recent.find(m => m.ts === targetTimestamp);
    if (!hit) {
      console.log(`[signal] Reaction ${emoji} ignored — not on a bot message (cache: ${recent.length} entries, target ts=${targetTimestamp})`);
      return;
    }

    // Contextualize the synthetic message with the original bot message text
    // so Claude knows WHAT was approved/rejected, not just a naked yes/no.
    const origText = (hit.text || '').slice(0, 2000);
    let syntheticText;
    if (answer === 'yes') {
      syntheticText = origText
        ? `[Reaction: 👍 approval]\n\nIn reference to your previous message:\n"${origText}"\n\nI approve / thumbs up. Proceed with whatever action that message proposed.`
        : 'yes';
    } else {
      syntheticText = origText
        ? `[Reaction: 👎 rejection]\n\nIn reference to your previous message:\n"${origText}"\n\nI don't approve / thumbs down. Cancel or do not proceed with whatever that message proposed.`
        : 'no';
    }

    console.log(`[signal] Reaction ${emoji} from ${senderId} in ${chatId} → dispatching "${answer}" (ctx=${origText ? origText.length + 'ch' : 'none'})`);
    const syntheticMsg = {
      chatId,
      senderId,
      senderName: senderId,
      text: syntheticText,
      attachments: [],
      mentions: [],
      timestamp: Date.now(),
      raw: null,
    };
    state._triggeredByTimestamp = syntheticMsg.timestamp;
    _dispatchSignalMessage(syntheticMsg, chatId, syntheticText, state).catch(err => {
      console.error('[signal] dispatch error (reaction):', err.message);
    });
  });

  // Handle "delete for everyone" in Signal — cancel queued/running task if triggered by this message
  signalAdapter.on('messageDelete', ({ chatId, deletedTimestamp }) => {
    const state = getChannel(`signal:${chatId}`);
    // 1. Cancel grouping timer if the deleted message is buffered
    if (state.groupingTimer && state.groupingBuffer?.length > 0) {
      const inBuffer = state.groupingBuffer.some(e => e.msg?.timestamp === deletedTimestamp);
      if (inBuffer) {
        state.groupingBuffer = state.groupingBuffer.filter(e => e.msg?.timestamp !== deletedTimestamp);
        if (state.groupingBuffer.length === 0) {
          clearTimeout(state.groupingTimer);
          state.groupingTimer = null;
          state.groupingSenderId = null;
          console.log(`[signal] Deleted message ${deletedTimestamp} was in grouping buffer — cancelled`);
          return;
        }
      }
    }
    // 2. Remove from queue
    const queueLenBefore = state.queue.length;
    state.queue = state.queue.filter(q => q._timestamp !== deletedTimestamp);
    if (state.queue.length < queueLenBefore) {
      console.log(`[signal] Deleted message ${deletedTimestamp} removed from queue`);
      saveChannelState(`signal:${chatId}`, state, { critical: true });
    }
    // 3. Stop active task if it was triggered by this message
    if (state.busy && state._triggeredByTimestamp === deletedTimestamp && state.process) {
      console.log(`[signal] Deleted message ${deletedTimestamp} was the active task — stopping`);
      try { state.process.kill('SIGTERM'); } catch {}
      state.busy = false;
      state._triggeredByTimestamp = null;
    }
  });

  // Start group-notes reminder loop — sends DM nudges for unresolved action items
  startReminderLoop(async (userId, msg) => {
    if (userId.startsWith('+') && signalAdapter && signalAdapter.ready) {
      await signalAdapter.sendLongMessage(userId, msg);
    }
  });

  // Restore pending safe-flight messages from previous boot
  restoreFlightJobs(async (groupId, msg, opts) => {
    if (signalAdapter && signalAdapter.ready) {
      await signalAdapter.sendMessage(groupId, msg, opts || {});
    }
  });

  signalAdapter.start().then(async () => {
    // Wire Signal into error alerting so critical errors go to owner's phone
    const { initSignal: _initSignalAlerts } = require('./error-alerting');
    _initSignalAlerts(signalAdapter);

    // Rebuild UUID→phone mapping from sidecar on startup. Non-fatal: if the
    // sidecar is unreachable we just proceed with whatever is already on disk.
    try {
      const { runDataRecovery } = require('./data-recovery');
      const apiUrl = process.env.SIGNAL_API_URL || 'http://signal-api:8080';
      const res = await runDataRecovery(signalAdapter.getUuidMap(), apiUrl, signalAdapter.phoneNumber);
      if (res && res.added > 0) signalAdapter.persistUuidMap();
    } catch (e) {
      console.warn('[startup] data-recovery failed (non-fatal):', e.message);
    }

    // Seed known group members from signal-api so existing group members
    // can DM the bot immediately (not just after their first group message
    // since this code was deployed).
    (async () => {
      try {
        const phone = signalAdapter.phoneNumber;
        if (!phone) return;
        const http = require('http');
        const resp = await new Promise((resolve, reject) => {
          const url = `${process.env.SIGNAL_API_URL || 'http://signal-api:8080'}/v1/groups/${encodeURIComponent(phone)}`;
          http.get(url, r => {
            let data = '';
            r.on('data', c => data += c);
            r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
          }).on('error', reject);
        });
        if (!Array.isArray(resp)) return;
        let seeded = 0;
        for (const g of resp) {
          if (!Array.isArray(g.members)) continue;
          for (const member of g.members) {
            if (member && member !== phone) {
              _addKnownGroupMember(member);
              seeded++;
            }
          }
        }
        // Also seed from the UUID→phone cache so UUIDs are recognized too
        const _uuidMap = signalAdapter.getUuidMap && signalAdapter.getUuidMap();
        if (_uuidMap && _uuidMap.byUuid) {
          for (const [uuid, entry] of Object.entries(_uuidMap.byUuid)) {
            const ph = entry && entry.phone;
            if (ph && _knownGroupMembers.has(ph)) _addKnownGroupMember(uuid);
          }
        }
        if (seeded > 0) {
          console.log(`[signal] Seeded ${_knownGroupMembers.size} known group member identifier(s) from signal-api`);
        }
      } catch (err) {
        console.warn(`[signal] Could not seed group members: ${err.message}`);
      }
    })();

    // Use pre-computed startup markers (read once at module load, no race condition).
    const { SIGNAL_OWNER } = require('./project-permissions');
    if (_startupMarkers.wasRebuild && SIGNAL_OWNER) {
      let rebuildMsg = 'Rebuild complete \u2014 I\u2019m back!';
      try {
        const { execSync } = require('child_process');
        const lastCommit = execSync('git log -1 --pretty=format:"%s"', { cwd: '/workspace/MyBot', encoding: 'utf8' }).trim();
        if (lastCommit) rebuildMsg += `\n\nJust shipped: ${lastCommit}`;
      } catch {}

      // Collect tasks to auto-resume (from .pending-work AND persisted channel state)
      const resumeLines = [];
      try {
        const pendingFile = path.join('/home/node/.claude', '.pending-work');
        if (fs.existsSync(pendingFile)) {
          const pending = fs.readFileSync(pendingFile, 'utf8').trim();
          if (pending) rebuildMsg += `\n\nUp next:\n${pending}`;
          fs.unlinkSync(pendingFile);
          // Collect both "Queued:" and "In progress:" lines for auto-resume
          resumeLines.push(...pending.split('\n').filter(l =>
            l.startsWith('Queued: ') || l.startsWith('In progress: ')
          ));
        }
      } catch {}

      // Resolve owner name dynamically instead of hardcoding
      let ownerName = 'Owner';
      try {
        const { getProfile } = require('./user-profiles');
        const ownerProfile = getProfile(SIGNAL_OWNER);
        if (ownerProfile?.name) ownerName = ownerProfile.name;
      } catch {}

      // Send rebuild notification first, then auto-resume tasks immediately
      // (no setTimeout — the Signal adapter is ready since we're inside .then())
      if (resumeLines.length > 0) {
        rebuildMsg += `\n\n_Auto-resuming ${resumeLines.length} task(s)..._`;
      }
      signalAdapter.sendMessage(SIGNAL_OWNER, rebuildMsg).then(() => {
        // Dispatch auto-resume tasks after the notification is confirmed sent
        for (const line of resumeLines) {
          const taskText = line.replace(/^(Queued|In progress):\s*/, '').trim();
          if (!taskText) continue;
          const chatId = `signal:${SIGNAL_OWNER}`;
          const state = getChannel(chatId);
          if (!state.busy) {
            const syntheticMsg = {
              chatId: SIGNAL_OWNER,
              senderId: SIGNAL_OWNER,
              senderName: ownerName,
              text: taskText,
              attachments: [],
              mentions: [],
              timestamp: Date.now(),
            };
            _dispatchSignalMessage(syntheticMsg, SIGNAL_OWNER, taskText, state).catch(err => {
              console.error('[signal] dispatch error (auto-resume):', err.message);
            });
          } else {
            state.queue.push({ content: taskText, timestamp: Date.now() });
            saveChannelState(chatId, state);
          }
        }
      }).catch(() => {});
      console.log('[signal] Sent rebuild-complete notification to owner');
    } else if (!_startupMarkers.wasClean && !_startupMarkers.wasRolledBack && SIGNAL_OWNER) {
      signalAdapter.sendMessage(SIGNAL_OWNER,
        '*Bot restarted unexpectedly (possible crash). I\u2019m back online now.*'
      ).catch(() => {});
      console.log('[signal] Sent crash notification to owner');
    }

    // Once the Signal adapter is ready, run the main bot startup
    // (schedulers, queue runner, monitors, channel-state restore, auto-resume).
    // startBot() is idempotent — the fallback timeout in start() is a no-op
    // when this path runs first.
    startBot().catch(err => console.error('[startBot] failed:', err.message));

    // Start watchdog that auto-restarts signal-api if its WebSocket goes stale
    const { startSignalWatchdog } = require('./signal-watchdog');
    startSignalWatchdog(signalAdapter, process.env.SIGNAL_OWNER_NUMBER);
  }).catch(err => {
    console.error(`[signal] Failed to start: ${err.message}`);
  });
}

async function _dispatchSignalMessage(msg, chatId, text, state) {
  const { buildMinimalProfileContext, buildProfileLookup, buildProfileContext, getProfile } = require('./user-profiles');
  const { isSignalOwner } = require('./project-permissions');

  // Resolve UUID→phone for downstream profile/calendar/preference lookups.
  // This can be called directly (e.g., from !testas) with a UUID senderId.
  if (msg.senderId && !msg.senderId.startsWith('+') && signalAdapter) {
    const resolved = signalAdapter._resolveRecipient(msg.senderId);
    if (resolved && resolved.startsWith('+')) {
      msg.senderId = resolved;
    }
  }

  const isGroupMessage = msg.chatId !== msg.senderId;
  const senderIsOwner = isSignalOwner(msg.senderId);
  const personalityFile = getPersonalityFile(state.personality);

  // Detect "still broken" feedback and mark the latest repair as failed
  // so the repair ledger context tells Bianca what didn't work.
  try {
    const repairLedger = require('./repair-ledger');
    if (repairLedger.isFailureFeedback(text)) {
      repairLedger.markLatestFailed(text.substring(0, 200));
    }
  } catch {}

  // Real Signal typing indicator (replaces the old "..." literal-message hack).
  // Signal typing dots auto-expire after a few seconds, so refresh on an interval
  // for the duration of Claude's run.
  // Moved inside try so failures don't leak busy=true / typing interval.
  let signalTypingInterval;
  try {
    await signalAdapter.sendTyping(msg.chatId).catch(() => {});
    signalTypingInterval = setInterval(() => {
      signalAdapter.sendTyping(msg.chatId).catch(() => {});
    }, 8000);

    // Reset session inactivity timer — any message resets the 15-min clock
    _resetSessionInactivityTimer(state, chatId);

    // Record incoming message to recentMessages for context persistence
    if (!state.recentMessages) state.recentMessages = [];
    state.recentMessages.push({
      role: 'user',
      text: text.substring(0, 1000),
      sender: msg.senderName || msg.senderId,
      timestamp: Date.now(),
    });
    if (state.recentMessages.length > 20) state.recentMessages = state.recentMessages.slice(-20);

    state._isGroupChat = isGroupMessage; // used by commands (e.g. !btw) to suppress in groups
    state.activeTask = {
      prompt: text.substring(0, 500),
      channelId: chatId,
      startedAt: new Date().toISOString(),
      resumeAttempts: 0,
    };
    if (!senderIsOwner && !_checkRateLimit(msg.senderId)) {
      clearInterval(signalTypingInterval);
      await signalAdapter.sendMessage(msg.chatId, 'You\'ve sent a lot of messages recently — please wait a few minutes before trying again.');
      return;
    }

    state.busy = true;
    saveChannelState(chatId, state, { critical: true });

      const signalProxy = ChannelProxy.fromSignal(signalAdapter, msg.chatId);

      // Build profile context. DMs use minimal profile + heuristic on-demand
      // data injection. Groups use the existing stripped path.
      let combinedProfileContext = buildMinimalProfileContext(msg.senderId, { isGroupChat: isGroupMessage });
      // Inject user preferences (email rules, shopping prefs, event settings) into context
      try {
        const { buildPrefContext } = require('./user-pref-context');
        const prefCtx = buildPrefContext(msg.senderId);
        if (prefCtx) combinedProfileContext = (combinedProfileContext || '') + '\n\n' + prefCtx;
      } catch {}
      // Heuristic: inject heavy profile data only when message likely needs it
      if (!isGroupMessage && text) {
        const lowerText = text.toLowerCase();
        const extraFields = [];
        if (/\b(concerts?|tickets?|music|artists?|shows?|tours?|touring|live|gigs?|setlist|spotify|festival|events?|playing|performing|!concerts|!prices|!setalert)\b/.test(lowerText)) {
          extraFields.push('artists');
        }
        if (/\b(note|list|saved|restaurant|remember|wrote down|my\s+(?:list|notes?))\b/.test(lowerText)) {
          extraFields.push('notes');
        }
        if (extraFields.length > 0) {
          const lookup = buildProfileLookup(msg.senderId, extraFields);
          if (lookup) combinedProfileContext = (combinedProfileContext || '') + '\n\n' + lookup;
        }
      }
      // (isGroupMessage already declared above in the access control block)
      if (isGroupMessage) {
        try {
          // Use cache to avoid an HTTP round-trip on every message
          let grp = null;
          const cached = _groupInfoCache.get(msg.chatId);
          if (cached && (Date.now() - cached.fetchedAt < _GROUP_CACHE_TTL_MS)) {
            grp = cached;
          } else {
            const groupInfo = await signalAdapter._fetch(`/v1/groups/${encodeURIComponent(signalAdapter.phoneNumber)}/${encodeURIComponent(signalAdapter._toPublicGroupId(msg.chatId))}`);
            if (groupInfo.ok) {
              grp = await groupInfo.json();
              _groupInfoCache.set(msg.chatId, { ...grp, fetchedAt: Date.now() });
            }
          }
          if (grp) {
            const rawMembers = grp.members || [];
            // If any member is an unresolved UUID, refresh contacts now so newly
            // onboarded users (who ran !setup after bot start) get included.
            const hasUnresolvedUuids = rawMembers.some(m =>
              !m.startsWith('+') && signalAdapter._resolveRecipient && signalAdapter._resolveRecipient(m) === m
            );
            if (hasUnresolvedUuids) {
              await signalAdapter._loadContacts().catch(() => {});
            }
            const memberIds = rawMembers.map(m => {
              if (m.startsWith('+')) return m;
              // Try UUID→phone via adapter cache
              const resolved = signalAdapter._resolveRecipient ? signalAdapter._resolveRecipient(m) : m;
              if (resolved && resolved.startsWith('+')) return resolved;
              // Fallback: find profile keyed by UUID (Signal UUID-only mode)
              try {
                const { findProfileBySignalUuid } = require('./user-profiles');
                const found = findProfileBySignalUuid ? findProfileBySignalUuid(m) : null;
                if (found) return found; // may be a phone OR a UUID key
              } catch {}
              return null;
            }).filter(m => {
              if (!m) return false;
              // Exclude self and the current sender — allow both phone and UUID-keyed profiles
              const senderResolved = msg.senderId;
              const botPhone = signalAdapter.phoneNumber;
              return m !== senderResolved && m !== botPhone && m !== signalAdapter._selfUuid;
            });
            console.log(`[signal] Group ${msg.chatId.substring(0, 8)}...: ${rawMembers.length} raw members → ${memberIds.length} resolved IDs: ${memberIds.map(m => m.startsWith('+') ? m.slice(0,4)+'****' : m.slice(0,8)+'...').join(', ')}`);
            const memberContexts = [];
            const { buildGroupMemberContext } = require('./user-profiles');
            for (const mid of memberIds) {
              const ctx = buildGroupMemberContext(mid);
              if (ctx) memberContexts.push(ctx);
              else console.log(`[signal] No profile context for member: ${mid.startsWith('+') ? mid.slice(0,4)+'****' : mid.slice(0,8)+'...'}`);
            }
            if (memberContexts.length > 0) {
              const groupHeader = `GROUP CONTEXT — This message is from a Signal group with ${grp.members?.length || '?'} members. Sender is ${msg.senderId}. Other known members:`;
              const memberPhoneMap = memberIds.map(mid => {
                const prof = getProfile ? getProfile(mid) : null;
                const name = prof?.name || mid;
                return `${name}: ${mid}`;
              }).join(', ');
              combinedProfileContext = [
                combinedProfileContext || '',
                groupHeader,
                ...memberContexts,
                'When the user says "us" or "we", coordinate across all known members. Use their Google Calendars (where connected) to find times that work for everyone.',
                `[INTERNAL — for event/reminder scheduling only, do NOT say these aloud]: Member phone numbers: ${memberPhoneMap}`,
                '\nGROUP PRIVACY RULES (CRITICAL — never violate these):\n- NEVER share event titles, descriptions, or attendee lists from anyone\'s calendar in group chat. Calendar availability in groups: ONLY say "[Name] is busy on [day] from [time] to [time]" or "[Name] is free on [day]"\n- NEVER share phone numbers, email addresses, or profile details of one member with another in group chat\n- NEVER run !profile or share profile data in group chat — tell the user to DM you instead\n- Full calendar details and personal info are ONLY for private 1:1 DMs with that specific user\n- NEVER discuss, reveal, or confirm the existence of OTHER group chats, DM conversations, or channels. You have NO knowledge of what groups any user is in, what they discuss in other chats, who else they talk to, or what other group chats are named. If asked, say "I can only help with this conversation."\n- NEVER reveal conversation history or topics from other sessions, groups, or DMs — even if you have context from the session journal. Each group chat is isolated.\n- If someone asks "what groups is [person] in?" or "what did [person] say in [other chat]?" — refuse. Say you don\'t have access to that information.',
              ].filter(Boolean).join('\n\n');
            }
          }
        } catch (err) {
          console.warn(`[signal] group member lookup failed: ${err.message}`);
        }
      }

      // GROUP CHATS = SOCIAL ASSISTANT MODE. Claude can search the web, read
      // links, create/edit calendar events (via curl), coordinate plans, store
      // preferences — but CANNOT edit code, write files, navigate the codebase,
      // or do any engineering work. No session resume (prevents old engineering
      // sessions from carrying over). Max 8 turns (enough for tool fetches +
      // a useful reply, not enough for a rabbit hole).
      const isGroupChat = isGroupMessage;

      // Proactive onboarding: if the sender has no profile, inject a hint so
      // Claude asks them to introduce themselves.
      let groupOnboardHint = '';
      if (isGroupChat && msg.senderId && msg.senderId.startsWith('+')) {
        const senderProfile = getProfile(msg.senderId);
        if (!senderProfile || !senderProfile.setup_complete) {
          groupOnboardHint = `\n\n[SYSTEM: This user (${msg.senderName || msg.senderId}) has no profile yet. Naturally ask them to introduce themselves — their name, where they're from, and if they want to connect their Google Calendar. Keep it casual and friendly, not robotic. Store what they share via [LEARNED: ...] tags.]`;
        }
      }

      // Inject pending event context for group chats so Claude can handle
      // "I'm in" / "add me" without session continuity.
      let pendingEventContext = '';
      if (isGroupChat) {
        try {
          const getPendingEvent = global.__mybotGetPendingEvent;
          const pending = getPendingEvent ? getPendingEvent(msg.chatId) : null;
          if (pending && (Date.now() - pending.createdAt < 24 * 60 * 60 * 1000)) {
            pendingEventContext = `\n\n[PENDING EVENT in this group — someone recently created this event. If the current user says "I'm in", "add me", "count me in", or similar, use POST /event/join with chat_id="${msg.chatId}" and user_id="${msg.senderId}" to add them.]\nEvent: "${pending.title}" on ${pending.datetime}${pending.location ? ` at ${pending.location}` : ''} — ${pending.attendees.length} attendee(s) so far.`;
          }
        } catch {}
      }

      // Inject active group notes so Claude knows what's pending
      let groupNotesContext = '';
      if (isGroupChat) {
        try {
          const activeNotes = getGroupNotes(msg.chatId);
          if (activeNotes.length > 0) {
            const noteLines = activeNotes.map(n => {
              const from = n.fromName || 'Someone';
              const target = n.targetName ? `@${n.targetName}` : 'everyone';
              const age = Math.round((Date.now() - n.createdAt) / (60 * 60 * 1000));
              const ageStr = age < 1 ? 'just now' : age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;
              return `- [${n.type}] ${from} → ${target}: "${n.summary}" (${ageStr}, id=${n.id})`;
            });
            groupNotesContext = `\n\n[ACTIVE GROUP NOTES — these are pending action items in this group chat. If the current message resolves one, include [RESOLVE_NOTE: <id>] in your response.]\n${noteLines.join('\n')}`;
          }
        } catch (e) {
          console.warn(`[group-notes] failed to build context: ${e.message}`);
        }
      }

      // Inject active flights context so Claude can check flight status
      let activeFlightsContext = '';
      if (isGroupChat) {
        try {
          const flightsData = require('./flight-tracker');
          // Load flights for this group that haven't departed yet
          const allFlights = JSON.parse(fs.readFileSync('/app/data/flights.json', 'utf8') || '[]');
          const upcoming = allFlights.filter(f =>
            f.groupId === msg.chatId &&
            new Date(f.departureTime).getTime() > Date.now() - 24 * 60 * 60 * 1000 // include flights from last 24h
          );
          if (upcoming.length > 0) {
            const lines = upcoming.map(f => {
              const dep = new Date(f.departureTime);
              const hoursUntil = Math.round((dep.getTime() - Date.now()) / (60 * 60 * 1000));
              const timeStr = hoursUntil > 0 ? `in ${hoursUntil}h` : `${Math.abs(hoursUntil)}h ago`;
              return `- ${f.travelerName || f.traveler}: ${f.airline || ''} ${f.flightNumber || 'unknown'} ${f.departureAirport}→${f.arrivalAirport} departing ${timeStr}`;
            });
            activeFlightsContext = `\n\n[ACTIVE FLIGHTS in this group — use these for flight status checks via WebSearch]\n${lines.join('\n')}`;
          }
        } catch {}
      }

      // Inject last-generated image context for refinement ("make the glasses bigger")
      let imageRefinementContext = '';
      try {
        const _imgReg = require('./image-registry');
        const lastImg = _imgReg.getLastOutput(chatId);
        if (lastImg) {
          imageRefinementContext = `\n\n[PREVIOUS IMAGE: You recently generated ${lastImg} for this chat. If the user is asking to refine, edit, or modify that image (e.g. "make it bigger", "change the color", "add a hat"), append \`INPUT:${lastImg}\` to your [IMAGINE:] tag to use it as the source.]`;
        }
      } catch {}

      // Owner Signal DM → Claude Code parity mode. Forces Opus 4.7, no brevity,
      // no personality, no turn limit, no stall/hard-timeout kill. Everything
      // else keeps its historical wrapper (groups, other Signal users). See
      // /home/karen/.claude/plans/no-i-have-another-glimmering-marshmallow.md
      // for the design rationale.
      const ownerDmMode = senderIsOwner && !isGroupChat;
      const ownerDmFullAccess = ownerDmMode && OWNER_FULL_ACCESS_ENABLED;
      // Plan mode (owner DM only): read-only exploration, no edits/bash/writes.
      // Toggled via `!mode plan` / `!mode auto`; default is auto.
      const planMode = ownerDmMode && state.codingMode === 'plan';

      // Non-owner DMs are aligned with group chats: same tool whitelist,
      // same turn cap (8), personality applied. readOnly=false so the Runner
      // uses the groupAllowedTools whitelist instead of the restrictive readOnly list.
      const isNonOwnerDm = !senderIsOwner && !isGroupChat;
      const nonOwnerToolWhitelist = 'Read,WebSearch,WebFetch,Task,TodoWrite';

      // Sandbox lookup — non-owner users with a configured sandbox get write
      // access scoped to their own directory (enforced by Linux file permissions).
      const { getSandboxUser } = require('./sandbox');
      const sandboxUser = !senderIsOwner ? getSandboxUser(msg.senderId) : null;
      if (sandboxUser) {
        console.log(`[sandbox] ${_redactId(msg.senderId)} matched sandbox: ${sandboxUser.name} (${sandboxUser.cwd})`);
      }

      const claudeOpts = {
        sessionId: isGroupChat ? null : state.sessionId,
        personalityFile,
        identity: state.identity,
        cwd: sandboxUser ? sandboxUser.cwd : state.cwd,
        channelState: state,
        channelProxy: signalProxy,
        discordUserId: msg.senderId,
        // Groups and non-owner DMs use a SOCIAL allowlist: web search, reading,
        // sub-agents — but NOT Edit/Write/Grep/Glob (engineering tools).
        // Sandbox users override this with their own tool set.
        readOnly: ownerDmMode ? !ownerDmFullAccess || planMode : false,
        groupAllowedTools: sandboxUser ? sandboxUser.allowedTools
          : (isGroupChat || isNonOwnerDm) ? nonOwnerToolWhitelist : undefined,
        profileContext: (combinedProfileContext || '') + groupOnboardHint + pendingEventContext + groupNotesContext + activeFlightsContext + imageRefinementContext
          + (isGroupChat ? `\n\nCHAT_ID: ${msg.chatId}\nSENDER_ID: ${msg.senderId}` : '')
          + (sandboxUser ? `\n\nSANDBOX: You are working in ${sandboxUser.name}'s project directory (${sandboxUser.cwd}). All file operations are restricted to this directory.` : ''),
        streamReplies: true,
        maxTurns: ownerDmMode ? null
          : ((isGroupChat || isNonOwnerDm) ? 20 : (senderIsOwner ? (parseInt(process.env.SIGNAL_OWNER_MAX_TURNS, 10) || 75) : 20)),
        ownerDmMode,
        planMode,
        isOwner: senderIsOwner,
        sandboxUser,
        // Pass recent messages for conversation context persistence
        recentMessages: state.recentMessages || [],
        // Model selection.
        //   - Owner DM → always Opus 4.7 (full 200k context)
        //   - Groups and non-owner DMs → Sonnet by default
        model: ownerDmMode ? 'claude-opus-4-7'
          : (isGroupChat ? 'sonnet'
          : (!senderIsOwner ? 'sonnet' : 'sonnet')),
      };

      // Auto-detect social/location links — pre-fetch metadata and build action prompt.
      // Mirrors the Discord handler at bot.js:~3250 — without this, TikTok/Instagram/etc.
      // links go straight to Claude which gets blocked by their bot walls.
      let signalPrompt = text;
      const detectedLinks = detectLinks(text);
      if (detectedLinks.length > 0) {
        const enriched = await enrichLinks(detectedLinks);
        signalPrompt = buildSmartPrompt(enriched) + text;
      }
      // TikTok transcript injection — fetch captions and append as context
      try {
        const { extractTikTokUrls, getTikTokTranscriptWithFallback } = require('./tiktok-transcript');
        const tiktokUrls = extractTikTokUrls(text);
        for (const turl of tiktokUrls) {
          const ttResult = await getTikTokTranscriptWithFallback(turl);
          if (ttResult && ttResult.transcript) {
            signalPrompt += `\n\n<video-transcript url="${turl}">\n${ttResult.transcript}\n</video-transcript>`;
          }
        }
      } catch (err) {
        console.error('[tiktok] Signal transcript error:', err.message);
      }
      // Instagram Reels transcript injection
      try {
        const { extractInstagramReelUrls, getInstagramTranscript } = require('./instagram-transcript');
        const igUrls = extractInstagramReelUrls(text);
        for (const igUrl of igUrls) {
          const igResult = await getInstagramTranscript(igUrl);
          if (igResult) {
            let block = `<video-transcript url="${igUrl}">`;
            if (igResult.transcript) block += `\n${igResult.transcript}`;
            else if (igResult.description) block += `\n[No audio transcript. Creator caption: ${igResult.description}]`;
            block += `\n</video-transcript>`;
            signalPrompt += `\n\n${block}`;
          }
        }
      } catch (err) {
        console.error('[instagram] Signal transcript error:', err.message);
      }

      // Auto-context: detect calendar/weather intent and pre-fetch data
      // so Claude has the answer already — no tag emission needed.
      try {
        const { enrichWithContext } = require('./auto-context');
        const autoCtx = await enrichWithContext(text, msg.senderId, isGroupChat);
        if (autoCtx) signalPrompt = autoCtx + signalPrompt;
      } catch (err) {
        console.warn(`[auto-context] enrichment failed: ${err.message}`);
      }

      let result;
      try {
        result = await runClaudeWithContinuation(signalPrompt, claudeOpts, signalProxy);
      } catch (err) {
        // Session resume failed — clear sessionId and retry fresh
        if (state.sessionId && (err.message?.includes('No conversation found') || err.message?.includes('session'))) {
          console.log(`[session-resume] Session ${state.sessionId} failed, retrying fresh: ${err.message}`);
          state.sessionId = null;
          state.sessionStartedAt = null; state.sessionTurns = 0; state.sessionCost = 0;
          claudeOpts.sessionId = null;
          result = await runClaudeWithContinuation(signalPrompt, claudeOpts, signalProxy);
        } else {
          throw err;
        }
      }

      // Session resume failed gracefully — retry without session
      if (result.sessionResumeFailed) {
        console.log(`[session-resume] Graceful retry without session for ${_redactId(chatId)}`);
        state.sessionId = null;
        state.sessionStartedAt = null; state.sessionTurns = 0; state.sessionCost = 0;
        claudeOpts.sessionId = null;
        result = await runClaudeWithContinuation(signalPrompt, claudeOpts, signalProxy);
      }

      // Auth failure — surface clearly and stop
      if (result.authFailed) {
        await signalAdapter.sendMessage(msg.chatId, '⚠️ Not logged in — Claude CLI needs re-authentication. Run `claude` on the host and use `/login` to refresh the token.');
        return;
      }

      // Record outgoing message to recentMessages for context persistence
      if (result.text) {
        if (!state.recentMessages) state.recentMessages = [];
        state.recentMessages.push({
          role: 'assistant',
          text: result.text.substring(0, 1000),
          timestamp: Date.now(),
        });
        if (state.recentMessages.length > 20) state.recentMessages = state.recentMessages.slice(-20);
      }

      // Auto-learn extraction — strip [LEARNED: ...] tags, store preferences, notify user.
      //
      // PII FILTER (deterministic): the LEARNED handler is a covert
      // storage channel — Claude can write any string to the sender's
      // profile, and prompt injection or model drift could cause it to
      // store credit card numbers, SSNs, passwords, or full appointment
      // text including titles. We refuse to persist anything that looks
      // like high-risk PII or that violates a hard length cap. Skipped
      // facts are logged + the user is told it was rejected (so they
      // know nothing was silently absorbed).
      const { addPreference } = require('./user-profiles');
      const learnedRe = /\[LEARNED:\s*(.+?)\]/gi;
      const learned = [];
      let cleanResultText = result.text || '';
      let learnedMatch;
      while ((learnedMatch = learnedRe.exec(cleanResultText)) !== null) {
        learned.push(learnedMatch[1].trim());
      }
      cleanResultText = cleanResultText.replace(learnedRe, '').trim();
      result.text = cleanResultText;

      // PII patterns we refuse to store. These run BEFORE addPreference
      // so the disk write never happens for blocked facts.
      const _MAX_LEARNED_FACT_CHARS = 200;
      const _PII_PATTERNS = [
        // Card numbers (13–19 digits, optionally separated by spaces/dashes)
        { name: 'card-number', re: /\b(?:\d[ -]*?){13,19}\b/ },
        // US SSN ddd-dd-dddd
        { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
        // Bare CVV next to a card-related word
        { name: 'cvv',  re: /\b(?:cvv|cvc)\s*[:=]?\s*\d{3,4}\b/i },
        // Anything calling itself a password / passcode / pin / secret.
        // No trailing \b — `pin: 1234` ends the keyword on a `:` followed
        // by a space, which is non-word↔non-word and never matches \b.
        // The leading \b alone is sufficient to avoid matching "passport".
        { name: 'secret-keyword', re: /\b(?:password|passcode|secret|api[\s-]?key|access[\s-]?token|pin\s*[:=])/i },
        // Bank routing/account hints
        { name: 'routing', re: /\brouting[\s\-]?(?:number|#)\b/i },
      ];

      for (const factRaw of learned) {
        const fact = (factRaw || '').trim();
        if (!fact) continue;

        // Length cap — Claude shouldn't be writing essays into the
        // preferences table. If a fact is over 200 chars, almost
        // certainly an error.
        if (fact.length > _MAX_LEARNED_FACT_CHARS) {
          console.warn(`[auto-learn] REJECTED oversized fact (${fact.length} chars) for ${msg.senderId.slice(0,4)}****`);
          await signalAdapter.sendMessage(msg.chatId, `⚠️ I tried to remember something but it was too long (${fact.length} chars, max ${_MAX_LEARNED_FACT_CHARS}). Not stored — rephrase as a short statement if you want me to keep it.`).catch(() => {});
          continue;
        }

        // PII pattern check — drop if any pattern hits.
        const hit = _PII_PATTERNS.find(p => p.re.test(fact));
        if (hit) {
          console.warn(`[auto-learn] REJECTED fact matching PII pattern "${hit.name}" for ${msg.senderId.slice(0,4)}****`);
          await signalAdapter.sendMessage(msg.chatId, `⚠️ I tried to save something but it looked like sensitive data (${hit.name}). Not stored. If you want me to remember a fact, rephrase without the sensitive details.`).catch(() => {});
          continue;
        }

        try {
          addPreference(msg.senderId, fact, 'conversation');
          await signalAdapter.sendMessage(msg.chatId, `\u{1F4DD} I noted: ${fact}. Say \`!forget ${fact}\` to remove.`);
        } catch (e) {
          console.warn(`[auto-learn] failed to store preference: ${e.message}`);
        }
      }

      // [UPDATE_NOTES:] tag extraction — update a specific personal note from chat.
      // Format: [UPDATE_NOTES: @userId noteTitle="Restaurant List" <content>]
      // If noteTitle matches an existing note, updates it. Otherwise creates a new one.
      const updateNotesRe = /\[UPDATE_NOTES:\s*@?(\S+)\s+(?:noteTitle="([^"]+)"\s+)?([\s\S]+?)\]/gi;
      let notesMatch;
      while ((notesMatch = updateNotesRe.exec(result.text || '')) !== null) {
        // SECURITY: Always use msg.senderId — never trust Claude's target userId.
        // Claude's output is ignored for identity; only noteTitle and content are used.
        const resolvedId = msg.senderId;
        const noteTitle = (notesMatch[2] || 'Notes').trim();
        const newContent = notesMatch[3].trim().substring(0, 10000);
        try {
          const { setProfile, getProfile: _gp } = require('./user-profiles');
          const profile = _gp(resolvedId);
          if (profile) {
            let notes = Array.isArray(profile.notes) ? [...profile.notes]
              : (profile.notes ? [{ id: 'migrated', title: 'Notes', content: profile.notes, updatedAt: new Date().toISOString() }] : []);
            // Find existing note by title (case-insensitive)
            const existing = notes.find(n => n.title.toLowerCase() === noteTitle.toLowerCase());
            if (existing) {
              existing.content = newContent;
              existing.updatedAt = new Date().toISOString();
            } else {
              notes.push({ id: 'n' + Date.now(), title: noteTitle.substring(0, 100), content: newContent, updatedAt: new Date().toISOString() });
            }
            setProfile(resolvedId, { notes });
            console.log(`[update-notes] ${existing ? 'Updated' : 'Created'} note "${noteTitle}" for ${resolvedId.substring(0, 8)}... (${newContent.length} chars)`);
          }
        } catch (e) { console.warn(`[update-notes] failed: ${e.message}`); }
      }
      if (updateNotesRe.test(result.text || '')) {
        result.text = (result.text || '').replace(updateNotesRe, '').trim();
      }

      // [IMAGINE:] tag extraction — server-side image generation without Bash.
      // Works in group chats where Bash is blocked. Claude outputs [IMAGINE: prompt]
      // and bot.js calls /imagine internally.
      const imagineRe = /\[IMAGINE:\s*(.+?)\]/gi;
      const imagineMatches = [...(result.text || '').matchAll(imagineRe)];
      if (imagineMatches.length > 0) {
        const http = require('http');
        const imageRegistry = require('./image-registry');
        for (const match of imagineMatches) {
          const raw = match[1].trim();
          // Check for INPUT: suffix for image-to-image refinement
          const inputMatch = raw.match(/^(.+?)\s+INPUT:(\S+)$/i);
          const imaginePrompt = inputMatch ? inputMatch[1].trim() : raw;
          const inputPath = inputMatch ? inputMatch[2] : (imageRegistry.getLastOutput(chatId) || null);
          try {
            const body = JSON.stringify({
              prompt: imaginePrompt,
              ...(inputPath ? { inputImagePath: inputPath } : {}),
            });
            const imgResult = await new Promise((resolve, reject) => {
              const req = http.request({
                hostname: 'localhost', port: 3400, path: '/imagine',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Internal-Token': INTERNAL_API_TOKEN,
                  'X-Session-Key': chatId,
                  'Content-Length': Buffer.byteLength(body),
                },
                timeout: 120000,
              }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                  try { resolve(JSON.parse(data)); } catch { reject(new Error('bad response')); }
                });
              });
              req.on('error', reject);
              req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
              req.write(body);
              req.end();
            });
            if (imgResult.path) {
              console.log(`[imagine-tag] Generated: ${imgResult.path}`);
            }
          } catch (e) {
            console.warn(`[imagine-tag] Failed: ${e.message}`);
          }
        }
        // Strip tags from text before sending to user
        result.text = (result.text || '').replace(imagineRe, '').trim();
      }

      // [CONCERT_PRICES:] tag extraction — get ticket prices without Bash.
      // Format: [CONCERT_PRICES: artist="Name" venue="Venue" date="YYYY-MM-DD" city="City"]
      const concertRe = /\[CONCERT_PRICES:\s*(.+?)\]/gi;
      const concertMatches = [...(result.text || '').matchAll(concertRe)];
      if (concertMatches.length > 0) {
        const http = require('http');
        for (const match of concertMatches) {
          const raw = match[1].trim();
          // Parse key="value" pairs
          const params = {};
          raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
          // Also handle bare artist name (no key=value)
          if (!params.artist && !raw.includes('=')) params.artist = raw;
          try {
            const body = JSON.stringify(params);
            const priceResult = await new Promise((resolve, reject) => {
              const req = http.request({
                hostname: 'localhost', port: 3400, path: '/concerts/prices',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_API_TOKEN, 'Content-Length': Buffer.byteLength(body) },
                timeout: 30000,
              }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ text: data }); } });
              });
              req.on('error', reject);
              req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
              req.write(body); req.end();
            });
            if (priceResult.text) {
              // Send as follow-up (can't append to streamed text)
              await signalAdapter.sendMessage(msg.chatId, priceResult.text);
              console.log(`[concert-prices] Got prices for: ${params.artist || 'unknown'}`);
            }
          } catch (e) { console.warn(`[concert-prices] Failed: ${e.message}`); }
        }
        // Strip the tags (but keep the appended price results)
        result.text = (result.text || '').replace(concertRe, '').trim();
      }

      // [CALENDAR:] tag extraction — read the sender's Google Calendar events
      // via the per-user OAuth token.
      //
      // SECURITY / DETERMINISM (CLAUDE.md rule): userId and isGroupChat are
      // NEVER taken from Claude's output — they come from msg.senderId and
      // the live chat context, and are re-asserted AFTER parsing Claude's
      // params so Claude's output cannot overwrite them.
      //
      // Concrete attack this blocks: Claude in a group chat emits
      //   `[CALENDAR: isGroupChat=""]`
      // Empty string is falsy on the server, which would then return full
      // event titles (leaking psychiatrist appointments, etc). Same for
      //   `[CALENDAR: userId="+1..."]`
      // which could try to fetch another member's calendar. The clobber
      // lines below make both attacks impossible — parse Claude's output
      // first, then overwrite the sensitive fields with trusted values.
      const calendarRe = /\[CALENDAR:\s*(.*?)\]/gi;
      const calendarMatches = [...(result.text || '').matchAll(calendarRe)];
      if (calendarMatches.length > 0 && msg?.senderId) {
        try {
          const http = require('http');
          for (const match of calendarMatches) {
            const raw = (match[1] || '').trim();
            // Parse Claude's params first (date range is the only thing
            // Claude is allowed to influence)…
            const params = {};
            raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
            // …then clobber the sensitive fields with trusted values.
            // Order matters: these assignments run AFTER the parse loop
            // so anything Claude emitted for userId/isGroupChat is
            // discarded. `!!isGroupChat` coerces to a strict boolean so
            // "" / "false" / undefined all collapse correctly.
            params.userId = msg.senderId;
            params.isGroupChat = !!isGroupChat;
            try {
              const body = JSON.stringify(params);
              const calResult = await new Promise((resolve, reject) => {
                const req = http.request({
                  hostname: 'localhost', port: 3400, path: '/calendar/events',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_API_TOKEN, 'Content-Length': Buffer.byteLength(body) },
                  timeout: 15000,
                }, (res) => {
                  let data = '';
                  res.on('data', c => data += c);
                  res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ text: data }); } });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.write(body); req.end();
              });
              if (calResult?.text) {
                await signalAdapter.sendMessage(msg.chatId, calResult.text);
                console.log(`[calendar-tag] ${msg.senderId.slice(0,4)}**** events ${params.fromDate || 'today'}..${params.toDate || '+7d'} (${calResult.count ?? '?'})`);
              }
            } catch (e) { console.warn(`[calendar-tag] lookup failed: ${e.message}`); }
          }
        } catch (e) { console.warn(`[calendar-tag] plugin error: ${e.message}`); }
        result.text = (result.text || '').replace(calendarRe, '').trim();
      }

      // [PRODUCT:] tag extraction — multi-store product search (Tier 1+2 free).
      // Format: [PRODUCT: query="dove 0% aluminum deodorant" wantPrices=true]
      // Or shorthand: [PRODUCT: dove 0% aluminum deodorant]
      const productRe = /\[PRODUCT:\s*(.+?)\]/gi;
      const productMatches = [...(result.text || '').matchAll(productRe)];
      if (productMatches.length > 0) {
        try {
          const productPlugin = require('./plugins/product-search');
          for (const match of productMatches) {
            const raw = match[1].trim();
            const params = {};
            raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
            // Shorthand: bare query
            if (!params.query && !raw.includes('=')) params.query = raw;
            if (!params.query) continue;
            try {
              const text = await productPlugin.searchProducts(params.query, {
                wantPrices: params.wantPrices === 'true',
              });
              if (text) {
                await signalAdapter.sendMessage(msg.chatId, text);
                console.log(`[product-tag] search "${params.query.slice(0, 50)}"`);
              }
            } catch (e) { console.warn(`[product-tag] lookup failed: ${e.message}`); }
          }
        } catch (e) { console.warn(`[product-tag] plugin error: ${e.message}`); }
        result.text = (result.text || '').replace(productRe, '').trim();
      }

      // [CART_ADD:] tag — deterministic cart gate. Two actions:
      //   action="propose" items="name1|url1,name2|url2" — store items in approval gate, show numbered list
      //   action="add" ids="1,2" — add approved items to cart (requires prior propose + user confirmation)
      // No "purchase" action exists — purchases are impossible by design.
      const cartAddRe = /\[CART_ADD:\s*(.+?)\]/gi;
      const cartAddMatches = [...(result.text || '').matchAll(cartAddRe)];
      if (cartAddMatches.length > 0 && msg?.senderId) {
        const approvalGate = require('./approval-gate');
        for (const match of cartAddMatches) {
          const raw = (match[1] || '').trim();
          const params = {};
          raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });

          if (params.action === 'propose' && params.items) {
            const items = params.items.split(',').map(s => {
              const [name, url] = s.split('|').map(p => p.trim());
              return { label: name || 'Unknown item', meta: { name, url: url || '' } };
            }).filter(i => i.meta.url);
            if (items.length === 0) continue;
            approvalGate.proposePending(msg.senderId, 'cart', items);
            const lines = items.map((a, i) => `${i + 1}. ${a.label}`);
            await signalAdapter.sendMessage(msg.chatId,
              `🛒 **Add to cart?**\n${lines.join('\n')}\n\nTell me which ones (e.g. "add 1" or "add all").`
            );
          } else if (params.action === 'add') {
            const idsRaw = params.ids || params.id || '';
            const idsToProcess = [];
            if (idsRaw === 'all') {
              const pending = approvalGate.getPending(msg.senderId, 'cart');
              if (pending) idsToProcess.push(...pending.map(p => p.id));
            } else {
              idsToProcess.push(...String(idsRaw).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean));
            }
            if (idsToProcess.length === 0) {
              await signalAdapter.sendMessage(msg.chatId, 'No pending cart items. Browse products first.');
              continue;
            }
            const results = [];
            for (const id of idsToProcess) {
              approvalGate.approvePending(msg.senderId, 'cart', id);
              const approval = approvalGate.consumeApproval(msg.senderId, 'cart', m => {
                const pending = approvalGate.getPending(msg.senderId, 'cart');
                const item = pending?.find(p => p.id === id);
                return item && m.url === item.meta.url;
              });
              if (!approval) { results.push(`⚠️ #${id}: not found`); continue; }
              // Cart addition via Playwright would go here (v2 — requires active browser session)
              results.push(`🛒 ${approval.name} — queued for cart (browser session required)`);
            }
            if (results.length) await signalAdapter.sendMessage(msg.chatId, results.join('\n'));
          }
        }
        result.text = (result.text || '').replace(cartAddRe, '').trim();
      }

      // [WEATHER:] tag extraction — Open-Meteo forecast without Bash.
      // Format: [WEATHER: location="Alameda CA" fromDate="YYYY-MM-DD" toDate="YYYY-MM-DD"]
      // Or shorthand: [WEATHER: Alameda CA]
      const weatherRe = /\[WEATHER:\s*(.+?)\]/gi;
      const weatherMatches = [...(result.text || '').matchAll(weatherRe)];
      if (weatherMatches.length > 0) {
        try {
          const weatherPlugin = require('./plugins/weather');
          for (const match of weatherMatches) {
            const raw = match[1].trim();
            const params = {};
            // Parse key="value" pairs
            raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
            // Shorthand: bare location with no key=value
            if (!params.location && !raw.includes('=')) params.location = raw;
            if (!params.location) continue;
            try {
              const text = await weatherPlugin.getForecast(
                params.location,
                params.fromDate || null,
                params.toDate || null,
              );
              if (text) {
                await signalAdapter.sendMessage(msg.chatId, text);
                console.log(`[weather-tag] forecast for ${params.location} ${params.fromDate || ''}..${params.toDate || ''}`);
              }
            } catch (e) { console.warn(`[weather-tag] lookup failed: ${e.message}`); }
          }
        } catch (e) { console.warn(`[weather-tag] plugin error: ${e.message}`); }
        result.text = (result.text || '').replace(weatherRe, '').trim();
      }

      // [REMIND:] tag extraction — create a Google Calendar reminder.
      //
      // SECURITY / DETERMINISM (H2): the user_id / discord_user_id fields are
      // NOT taken from Claude's output — they are clobbered with msg.senderId
      // after the parse loop. Same parse-then-clobber pattern used by [CALENDAR:].
      const remindRe = /\[REMIND:\s*(.+?)\]/gi;
      const remindMatches = [...(result.text || '').matchAll(remindRe)];
      if (remindMatches.length > 0 && msg?.senderId) {
        try {
          const http = require('http');
          for (const match of remindMatches) {
            const raw = (match[1] || '').trim();
            const params = {};
            raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
            // Bare numeric duration_minutes=15 (no quotes)
            raw.replace(/(\w+)=(\d+)/g, (_, k, v) => { params[k] = v; });
            // Clobber identity fields — Claude does not get to choose who the reminder is for.
            params.discord_user_id = msg.senderId;
            params.user_id = msg.senderId;
            if (!params.title || !params.datetime) continue;
            try {
              const body = JSON.stringify({
                title: params.title,
                datetime: params.datetime,
                duration_minutes: parseInt(params.duration_minutes, 10) || 15,
                discord_user_id: msg.senderId,
                user_id: msg.senderId,
              });
              const remResult = await new Promise((resolve, reject) => {
                const req = http.request({
                  hostname: 'localhost', port: 3400, path: '/remind',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_API_TOKEN, 'Content-Length': Buffer.byteLength(body) },
                  timeout: 15000,
                }, (res) => {
                  let data = '';
                  res.on('data', c => data += c);
                  res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ text: data }); } });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.write(body); req.end();
              });
              if (remResult?.error) {
                await signalAdapter.sendMessage(msg.chatId, `Reminder failed: ${remResult.error}`);
              }
              console.log(`[remind-tag] ${msg.senderId.slice(0,4)}**** "${params.title.slice(0,40)}" at ${params.datetime}`);
            } catch (e) { console.warn(`[remind-tag] failed: ${e.message}`); }
          }
        } catch (e) { console.warn(`[remind-tag] handler error: ${e.message}`); }
        result.text = (result.text || '').replace(remindRe, '').trim();
      }

      // [SET_PREF:] tag — save a user preference rule to disk (deterministic preference storage).
      // Applied later at handler level (e.g. EVENT) — Claude never has to "remember" it.
      const setPrefRe = /\[SET_PREF:\s*(.+?)\]/gi;
      const setPrefMatches = [...(result.text || '').matchAll(setPrefRe)];
      if (setPrefMatches.length > 0 && msg?.senderId) {
        try {
          const { setPref, parseSetPrefTag } = require('./user-prefs');
          for (const match of setPrefMatches) {
            const { domain, rule } = parseSetPrefTag(match[1]);
            if (rule.match && rule.match.length > 0) {
              setPref(msg.senderId, domain, rule);
              console.log(`[pref] Saved ${domain} pref for ${msg.senderId.slice(0,4)}****: match=${rule.match.join(',')} color=${rule.color || '-'} duration=${rule.duration_minutes || '-'}`);
            }
          }
        } catch (e) { console.warn(`[pref] SET_PREF handler error: ${e.message}`); }
        result.text = (result.text || '').replace(setPrefRe, '').trim();
      }

      // [EMAIL_UNSUB:] tag — newsletter unsubscribe with deterministic approval gate.
      // action="suggest": analyze inbox, propose candidates, store in approval gate
      // action="confirm" id=N|ids="1,2,3"|ids="all": approve + execute in one step (conversational)
      // action="confirm" sender="x": execute by sender name (requires prior approval via !unsub yes)
      const emailUnsubRe = /\[EMAIL_UNSUB:\s*(.+?)\]/gi;
      const emailUnsubMatches = [...(result.text || '').matchAll(emailUnsubRe)];
      if (emailUnsubMatches.length > 0 && msg?.senderId) {
        const approvalGate = require('./approval-gate');
        for (const match of emailUnsubMatches) {
          const raw = (match[1] || '').trim();
          const params = {};
          raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
          raw.replace(/(\w+)=(\d+)/g, (_, k, v) => { params[k] = parseInt(v, 10); });

          if (params.action === 'suggest') {
            try {
              const { analyzeNewsletters } = require('./newsletter-analyzer');
              const candidates = await analyzeNewsletters(msg.senderId, params.days || 30);
              if (!candidates || candidates.length === 0) {
                await signalAdapter.sendMessage(msg.chatId, 'No newsletter unsubscribe candidates found.');
              } else {
                const actions = candidates.slice(0, 10).map(c => ({
                  label: `${c.sender} (${c.count} emails, ${Math.round(c.unreadRate * 100)}% unread)`,
                  meta: { sender: c.sender, domain: c.domain, messageId: c.latestMessageId },
                }));
                approvalGate.proposePending(msg.senderId, 'unsub', actions);
                const lines = actions.map((a, i) => `${i + 1}. ${a.label}`);
                await signalAdapter.sendMessage(msg.chatId,
                  `📧 **Unsubscribe candidates:**\n${lines.join('\n')}\n\nTell me which ones to unsubscribe from (e.g. "do 1 and 3" or "all of them").`
                );
              }
            } catch (e) { console.warn(`[email-unsub] suggest error: ${e.message}`); }
          } else if (params.action === 'confirm') {
            // Resolve which IDs to process — supports id=N, ids="1,3,5", ids="all"
            const idsToProcess = [];
            if (params.ids === 'all' || params.id === 'all') {
              const pending = approvalGate.getPending(msg.senderId, 'unsub');
              if (pending) idsToProcess.push(...pending.map(p => p.id));
            } else if (params.ids) {
              idsToProcess.push(...String(params.ids).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean));
            } else if (params.id) {
              idsToProcess.push(typeof params.id === 'number' ? params.id : parseInt(params.id, 10));
            } else if (params.sender) {
              // Legacy: direct sender lookup (requires prior !unsub yes)
              const approval = approvalGate.consumeApproval(msg.senderId, 'unsub', m => m.sender === params.sender);
              if (approval) idsToProcess.push(-1); // sentinel — handled below
            }

            if (idsToProcess.length === 0) {
              await signalAdapter.sendMessage(msg.chatId, 'No pending unsubscribe suggestions found. Ask me to scan your inbox first.');
              continue;
            }

            // Approve + execute each ID
            const { unsubscribe: doUnsub, getGmailClient } = require('./gmail-client');
            const gmail = await getGmailClient(msg.senderId);
            if (!gmail) {
              await signalAdapter.sendMessage(msg.chatId, 'Gmail not connected. Use !connect first.');
              continue;
            }
            const results = [];
            for (const id of idsToProcess) {
              // Approve and consume in one step
              if (id > 0) approvalGate.approvePending(msg.senderId, 'unsub', id);
              const pending = approvalGate.getPending(msg.senderId, 'unsub');
              const item = id > 0 ? pending?.find(p => p.id === id) : null;
              const approval = id > 0
                ? approvalGate.consumeApproval(msg.senderId, 'unsub', m => item && m.sender === item.meta.sender)
                : null; // sentinel case already consumed above
              if (!approval && id > 0) { results.push(`⚠️ #${id}: not found`); continue; }
              const sender = approval?.sender || params.sender;
              const messageId = approval?.messageId || null;
              if (!messageId) { results.push(`⚠️ ${sender}: no message ID`); continue; }
              try {
                const res = await doUnsub(gmail, messageId);
                results.push(res.success ? `✅ ${sender}` : `⚠️ ${sender}: ${res.detail}`);
                try {
                  const auditPath = path.join('/app/data', 'unsub-audit.json');
                  let audit = []; try { audit = JSON.parse(fs.readFileSync(auditPath, 'utf8')); } catch {}
                  audit.push({ ts: new Date().toISOString(), userId: msg.senderId, sender, ...res });
                  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
                } catch {}
              } catch (e) { results.push(`❌ ${sender}: ${e.message}`); }
            }
            if (results.length) await signalAdapter.sendMessage(msg.chatId, results.join('\n'));
          }
        }
        result.text = (result.text || '').replace(emailUnsubRe, '').trim();
      }

      // [EVENT:] tag extraction — create a shared group calendar event.
      //
      // SECURITY / DETERMINISM (H2): chat_id is clobbered with msg.chatId; the
      // creator (msg.senderId) is always included in user_ids. user_ids that
      // Claude emits are ALSO filtered against the known group member cache to
      // prevent Claude from inviting arbitrary phone numbers.
      const eventRe = /\[EVENT:\s*(.+?)\]/gi;
      const eventMatches = [...(result.text || '').matchAll(eventRe)];
      if (eventMatches.length > 0 && msg?.senderId && msg?.chatId) {
        try {
          const http = require('http');
          // Resolve allowed user_ids for this group (members + sender)
          const cached = _groupInfoCache.get(msg.chatId);
          const allowedMembers = new Set();
          allowedMembers.add(msg.senderId);
          if (cached?.members) {
            for (const m of cached.members) {
              if (typeof m === 'string' && m.startsWith('+')) allowedMembers.add(m);
            }
          }
          for (const match of eventMatches) {
            const raw = (match[1] || '').trim();
            const params = {};
            raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
            raw.replace(/(\w+)=(\d+)/g, (_, k, v) => { params[k] = v; });
            if (!params.title || !params.datetime) continue;
            // DETERMINISTIC PREF OVERLAY: load sender's saved event rules and
            // apply any that keyword-match this title, before we build the body.
            try {
              const { matchEventPrefs } = require('./user-prefs');
              const prefOverrides = matchEventPrefs(msg.senderId, params.title);
              if (prefOverrides.colorId) params.colorId = prefOverrides.colorId;
              if (prefOverrides.color) params.color = prefOverrides.color;
              if (prefOverrides.duration_minutes && !params.duration_minutes) params.duration_minutes = prefOverrides.duration_minutes;
              if (prefOverrides.reminder_minutes != null && params.reminder_minutes == null) params.reminder_minutes = prefOverrides.reminder_minutes;
              if (Object.keys(prefOverrides).length > 0) {
                console.log(`[event-tag] Applied pref overrides for "${params.title.slice(0,30)}": ${JSON.stringify(prefOverrides)}`);
              }
            } catch (e) { console.warn(`[event-tag] pref overlay error: ${e.message}`); }
            // Parse user_ids list and filter to known group members.
            // user_ids can be comma-separated phone numbers in the params.
            let claimed = [];
            if (params.user_ids) {
              claimed = params.user_ids.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
            }
            // Always include the sender. Filter every other id against the
            // group member cache so Claude can't add strangers.
            const uids = new Set();
            uids.add(msg.senderId);
            for (const id of claimed) {
              if (allowedMembers.has(id)) uids.add(id);
            }
            try {
              const body = JSON.stringify({
                title: params.title,
                datetime: params.datetime,
                duration_minutes: parseInt(params.duration_minutes, 10) || 120,
                location: params.location || '',
                description: params.description || '',
                user_ids: Array.from(uids),
                chat_id: msg.chatId,  // CLOBBER: never trust Claude
                color_id: params.colorId || null,
                color_name: params.color || null,
                reminder_minutes: params.reminder_minutes != null ? parseInt(params.reminder_minutes, 10) : null,
              });
              const evResult = await new Promise((resolve, reject) => {
                const req = http.request({
                  hostname: 'localhost', port: 3400, path: '/event',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_API_TOKEN, 'Content-Length': Buffer.byteLength(body) },
                  timeout: 20000,
                }, (res) => {
                  let data = '';
                  res.on('data', c => data += c);
                  res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ text: data }); } });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.write(body); req.end();
              });
              console.log(`[event-tag] ${msg.senderId.slice(0,4)}**** "${params.title.slice(0,40)}" → ${uids.size} attendees, created=${evResult?.created?.length || 0} failed=${evResult?.failed?.length || 0}`);
            } catch (e) { console.warn(`[event-tag] failed: ${e.message}`); }
          }
        } catch (e) { console.warn(`[event-tag] handler error: ${e.message}`); }
        result.text = (result.text || '').replace(eventRe, '').trim();
      }

      // [EVENT_JOIN:] tag extraction — add a user to an existing group event.
      //
      // SECURITY / DETERMINISM (H2): chat_id is clobbered with msg.chatId;
      // user_id is clobbered with msg.senderId (you can only opt yourself in).
      const eventJoinRe = /\[EVENT_JOIN:\s*(.+?)\]/gi;
      const eventJoinMatches = [...(result.text || '').matchAll(eventJoinRe)];
      if (eventJoinMatches.length > 0 && msg?.senderId && msg?.chatId) {
        try {
          const http = require('http');
          // Only one join action makes sense per turn — but loop in case Claude emits multiple
          for (const _ of eventJoinMatches) {
            try {
              const body = JSON.stringify({
                chat_id: msg.chatId,    // CLOBBER
                user_id: msg.senderId,  // CLOBBER — you can only join yourself
              });
              await new Promise((resolve, reject) => {
                const req = http.request({
                  hostname: 'localhost', port: 3400, path: '/event/join',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_API_TOKEN, 'Content-Length': Buffer.byteLength(body) },
                  timeout: 15000,
                }, (res) => {
                  let data = '';
                  res.on('data', c => data += c);
                  res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ text: data }); } });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.write(body); req.end();
              });
              console.log(`[event-join-tag] ${msg.senderId.slice(0,4)}**** joined event in ${msg.chatId.slice(0,8)}…`);
              break; // one join per turn is enough
            } catch (e) { console.warn(`[event-join-tag] failed: ${e.message}`); }
          }
        } catch (e) { console.warn(`[event-join-tag] handler error: ${e.message}`); }
        result.text = (result.text || '').replace(eventJoinRe, '').trim();
      }

      // [REBUILD] tag extraction — Claude self-rebuild signal.
      //
      // SECURITY / DETERMINISM (H2): only the bot owner can trigger a rebuild.
      // This is enforced by checking msg.senderId against the configured owner.
      // Claude in a group chat or non-owner DM cannot trigger the rebuild even
      // if it emits the tag.
      const rebuildRe = /\[REBUILD\]/gi;
      if (rebuildRe.test(result.text || '') && msg?.senderId) {
        try {
          const { isSignalOwner } = require('./project-permissions');
          if (isSignalOwner(msg.senderId) && !isGroupChat) {
            const http = require('http');
            try {
              const rebuildResult = await new Promise((resolve, reject) => {
                const req = http.request({
                  hostname: 'localhost', port: 3400, path: '/rebuild',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_API_TOKEN, 'Content-Length': 0 },
                  timeout: 30000,
                }, (res) => {
                  let data = '';
                  res.on('data', c => data += c);
                  res.on('end', () => {
                    try { resolve({ status: res.statusCode, ...JSON.parse(data) }); }
                    catch { resolve({ status: res.statusCode, text: data }); }
                  });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.end();
              });
              if (rebuildResult.status === 400 && rebuildResult.error) {
                // NextSteps.md gate or syntax check blocked the rebuild — notify the user
                console.warn(`[rebuild-tag] blocked by server: ${rebuildResult.error}`);
                await signalAdapter.sendMessage(msg.chatId,
                  `⚠️ Rebuild blocked: ${rebuildResult.error}`
                ).catch(() => {});
              } else {
                console.log(`[rebuild-tag] triggered by ${msg.senderId.slice(0,4)}****`);
              }
            } catch (e) { console.warn(`[rebuild-tag] failed: ${e.message}`); }
          } else {
            console.warn(`[rebuild-tag] denied — sender ${msg.senderId.slice(0,4)}**** is not owner or in group chat`);
          }
        } catch (e) { console.warn(`[rebuild-tag] handler error: ${e.message}`); }
        result.text = (result.text || '').replace(rebuildRe, '').trim();
      }

      // [FLIGHT_SEARCH:] tag extraction — search Google Flights and record snapshot.
      const flightSearchRe = /\[FLIGHT_SEARCH:\s*(.+?)\]/gi;
      const flightMatches = [...(result.text || '').matchAll(flightSearchRe)];
      if (flightMatches.length > 0) {
        try {
          const flightPrices = require('./plugins/flight-prices');
          for (const match of flightMatches) {
            const raw = match[1].trim();
            const params = {};
            raw.replace(/(\w+)=(\S+)/g, (_, k, v) => { params[k] = v; });
            if (params.origin && params.destination && params.date) {
              const flightText = await flightPrices.checkFlightPrices(
                params.origin, params.destination, params.date,
                { airline: params.airline || null, returnDate: params.returnDate || null }
              );
              if (flightText) {
                await signalAdapter.sendMessage(msg.chatId, flightText);
                console.log(`[flight-search] Results for ${params.origin}→${params.destination}`);
              }
            }
          }
        } catch (e) { console.warn(`[flight-search] tag error: ${e.message}`); }
        result.text = (result.text || '').replace(flightSearchRe, '').trim();
      }
      // Also handle legacy [FLIGHT_PRICE:] tags for backward compat
      const flightPriceRe = /\[FLIGHT_PRICE:\s*(.+?)\]/gi;
      if (flightPriceRe.test(result.text || '')) {
        result.text = (result.text || '').replace(flightPriceRe, '').trim();
      }

      // [EIGHTSLEEP:] tag extraction — control Eight Sleep bed without Bash.
      // Format: [EIGHTSLEEP: action side params]
      const eightSleepRe = /\[EIGHTSLEEP:\s*(.+?)\]/gi;
      const eightSleepMatches = [...(result.text || '').matchAll(eightSleepRe)];
      if (eightSleepMatches.length > 0) {
        try {
          const eightSleep = require('./eight-sleep');
          for (const match of eightSleepMatches) {
            const parts = match[1].trim().split(/\s+/);
            const action = (parts[0] || '').toLowerCase();
            let side = (parts[1] || 'my').toLowerCase();
            const userId = msg.senderId;
            // Resolve "my" to the user's stored side
            if (side === 'my' || side === 'mine') {
              const _p = require('./user-profiles').getProfile(msg.senderId);
              side = _p?.eightsleep_side || 'left';
            }
            let statusMsg = '';
            try {
              if (action === 'status') {
                const s = await eightSleep.getStatus(userId, side);
                if (s?.error) statusMsg = `Eight Sleep error: ${s.error}`;
                else if (s) {
                  // Auto-save side mapping based on owner names
                  const _up = require('./user-profiles');
                  const senderProfile = _up.getProfile(msg.senderId);
                  if (senderProfile && !senderProfile.eightsleep_side && s.leftOwner && s.rightOwner) {
                    const senderName = senderProfile.name?.toLowerCase();
                    if (senderName && s.leftOwner.toLowerCase().includes(senderName)) {
                      _up.setProfile(msg.senderId, { eightsleep_side: 'left' });
                      console.log(`[eight-sleep] Auto-detected: ${senderProfile.name} sleeps on the left`);
                    } else if (senderName && s.rightOwner.toLowerCase().includes(senderName)) {
                      _up.setProfile(msg.senderId, { eightsleep_side: 'right' });
                      console.log(`[eight-sleep] Auto-detected: ${senderProfile.name} sleeps on the right`);
                    }
                  }
                  const owner = side === 'left' ? s.leftOwner : s.rightOwner;
                  const ownerStr = owner ? ` (${owner})` : '';
                  const levelStr = s.level != null ? `, level ${s.level > 0 ? '+' : ''}${s.level}` : '';
                  const targetStr = s.targetLevel != null && s.targetLevel !== s.level ? ` → target ${s.targetLevel > 0 ? '+' : ''}${s.targetLevel}` : '';
                  const durationStr = s.durationRemaining ? ` (${s.durationRemaining}min remaining)` : '';
                  statusMsg = `🛏️ ${side} side${ownerStr}: ${s.on ? 'ON' : 'OFF'}${levelStr}${targetStr}${durationStr}`;
                }
                else statusMsg = 'Could not read Eight Sleep status — check your credentials in !setup.';
              } else if (action === 'set') {
                const level = parseInt(parts[2], 10) || 0;
                await eightSleep.setTemp(userId, side, level);
                statusMsg = `🛏️ Set ${side} side to level ${level}`;
              } else if (action === 'on') {
                await eightSleep.turnOn(userId, side);
                statusMsg = `🛏️ Turned ${side} side ON`;
              } else if (action === 'off') {
                await eightSleep.turnOff(userId, side);
                statusMsg = `🛏️ Turned ${side} side OFF`;
              }
              if (statusMsg) {
                console.log(`[eight-sleep] ${statusMsg}`);
                // Send as follow-up message (can't append to result.text — streaming already sent it)
                await signalAdapter.sendMessage(msg.chatId, statusMsg);
              }
            } catch (e) {
              console.warn(`[eight-sleep] ${action} failed: ${e.message}`);
              await signalAdapter.sendMessage(msg.chatId, `Eight Sleep error: ${e.message?.substring(0, 200)}`);
            }
          }
        } catch (e) { console.warn(`[eight-sleep] module error: ${e.message}`); }
        result.text = (result.text || '').replace(eightSleepRe, '').trim();
      }

      // [BACKGROUND:] tag — Bianca can kick off background tasks mid-conversation.
      // Format: [BACKGROUND: description | prompt to execute]
      // The description is shown to the user; the prompt runs as a separate Claude session.
      // SECURITY (H2): only the owner in a DM can trigger background tasks.
      // Same gate as [REBUILD] — non-owners and group chats strip the tag silently.
      const bgRe = /\[BACKGROUND:\s*(.+?)\]/gi;
      const bgMatches = [...(result.text || '').matchAll(bgRe)];
      if (bgMatches.length > 0 && senderIsOwner && !isGroupChat) {
        if (!state._bgTasks) state._bgTasks = new Map();
        for (const bgMatch of bgMatches) {
          const raw = bgMatch[1].trim();
          const pipeIdx = raw.indexOf('|');
          const description = pipeIdx > 0 ? raw.substring(0, pipeIdx).trim() : raw.substring(0, 80);
          const bgPrompt = pipeIdx > 0 ? raw.substring(pipeIdx + 1).trim() : raw;

          const taskId = `bg-${Date.now().toString(36)}`;
          const bgTask = {
            id: taskId, description, startedAt: Date.now(),
            status: 'running', result: null, cost: 0, numTurns: 0,
          };
          state._bgTasks.set(taskId, bgTask);
          console.log(`[bg-task] Started ${taskId}: ${description}`);

          (async () => {
            try {
              const bgResult = await askClaude(bgPrompt, {
                personalityFile: getPersonalityFile(state.personality),
                identity: state.identity,
                cwd: state.cwd,
                maxTurns: state.config?.maxTurns || 30,
                channelState: null,
                model: 'sonnet',
                ownerDmMode: true,
                isOwner: true,
              });
              bgTask.status = bgResult.stopped ? 'stopped' : 'done';
              bgTask.result = (bgResult.text || '').substring(0, 2000);
              bgTask.cost = bgResult.cost || 0;
              bgTask.numTurns = bgResult.numTurns || 0;
              bgTask.completedAt = Date.now();

              const elapsed = Math.round((bgTask.completedAt - bgTask.startedAt) / 1000);
              const timeStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
              const summary = bgTask.result.length > 500 ? bgTask.result.substring(0, 497) + '...' : bgTask.result;
              await signalAdapter.sendLongMessage(msg.chatId,
                `✅ Background task done: **${description}**\n${timeStr} · ${bgTask.numTurns} turns · $${bgTask.cost.toFixed(4)}\n\n${summary}`
              );
            } catch (err) {
              bgTask.status = 'error';
              bgTask.result = err.message;
              bgTask.completedAt = Date.now();
              console.error(`[bg-task] ${taskId} failed:`, err.message);
              await signalAdapter.sendMessage(msg.chatId, `❌ Background task failed: ${description}\n${err.message.substring(0, 200)}`).catch(() => {});
            }
          })();
        }
        result.text = (result.text || '').replace(bgRe, '').trim();
      } else if (bgMatches.length > 0) {
        // Non-owner or group chat: strip tags silently without spawning sessions
        result.text = (result.text || '').replace(bgRe, '').trim();
      }

      // Group notes extraction — detect [NOTE:...] tags and store action items
      if (isGroupChat) {
        try {
          // Build group members list for name→phone resolution
          const cached = _groupInfoCache.get(msg.chatId);
          const memberList = [];
          if (cached && cached.members) {
            for (const mid of cached.members) {
              if (mid.startsWith('+')) {
                const p = getProfile(mid);
                if (p && p.name) memberList.push({ id: mid, name: p.name });
              }
            }
          }
          const detectedNotes = extractNotes(result.text, {
            groupId: msg.chatId,
            from: msg.senderId,
            fromName: msg.senderName || (getProfile(msg.senderId) || {}).name || null,
            groupMembers: memberList,
          });
          for (const n of detectedNotes) {
            addNote(n);
          }
          // Resolve notes that Claude marked as done
          const resolveRe = /\[RESOLVE_NOTE:\s*([a-f0-9]+)\]/gi;
          let resolveMatch;
          while ((resolveMatch = resolveRe.exec(result.text)) !== null) {
            const { resolveNote } = require('./group-notes');
            resolveNote(resolveMatch[1]);
          }
          // Strip note/resolve tags from user-visible output
          result.text = stripNoteTags(result.text).replace(/\[RESOLVE_NOTE:\s*[a-f0-9]+\]/gi, '').trim();
        } catch (e) {
          console.warn(`[group-notes] extraction failed: ${e.message}`);
        }
      }

      // Flight detection — extract [FLIGHT:...] tags and set up calendar + safe-flight msg
      if (isGroupChat) {
        try {
          const detectedFlights = extractFlightTag(result.text);
          for (const fi of detectedFlights) {
            // Resolve group members for calendar events
            const cached = _groupInfoCache.get(msg.chatId);
            const members = cached?.members?.filter(m => m.startsWith('+') && m !== signalAdapter.phoneNumber) || [];
            await registerFlight({
              ...fi,
              groupId: msg.chatId,
              traveler: msg.senderId,
              travelerName: msg.senderName || (getProfile(msg.senderId) || {}).name || null,
              groupMembers: members,
            }, async (groupId, text, opts) => {
              if (signalAdapter && signalAdapter.ready) {
                await signalAdapter.sendMessage(groupId, text, opts || {});
              }
            });
          }
          result.text = stripFlightTags(result.text);
        } catch (e) {
          console.warn(`[flight-tracker] extraction failed: ${e.message}`);
        }
      }

      // If the group onboard hint was injected this turn, mark the sender
      // as onboarded so the hint doesn't fire again on every message.
      // The user either shared their info (stored via [LEARNED:] above)
      // or chose not to — either way, don't keep pestering them.
      if (groupOnboardHint && msg.senderId && msg.senderId.startsWith('+')) {
        try {
          const { setProfile: _sp } = require('./user-profiles');
          const existing = getProfile(msg.senderId);
          if (!existing || !existing.setup_complete) {
            _sp(msg.senderId, { setup_complete: true, greeted: true });
          }
        } catch (e) {
          console.warn(`[group-onboard] failed to mark setup_complete: ${e.message}`);
        }
      }

      if (result.sessionId) {
        state.sessionId = result.sessionId;
        if (!state.sessionStartedAt) state.sessionStartedAt = Date.now();
      }
      state.sessionTurns += (result.numTurns || 0);
      state.sessionCost += (result.cost || 0);

      // Cost guardrail — auto-clear session if cost cap exceeded
      const maxCost = state.config?.maxSessionCost;
      if (maxCost && state.sessionCost >= maxCost) {
        await signalAdapter.sendMessage(msg.chatId,
          `💰 Session cost cap reached ($${state.sessionCost.toFixed(4)} / $${maxCost.toFixed(2)}). Session cleared — next message starts fresh.`
        ).catch(() => {});
        state.sessionId = null;
        state.sessionStartedAt = null; state.sessionTurns = 0; state.sessionCost = 0;
        saveChannelState(chatId, state, { critical: true });
      }

      // Voice response: if the user sent a voice message, speak the response back
      if (state._isVoiceMessage && !result.stopped && result.text) {
        try {
          const voiceTts = require('./voice-tts');
          if (voiceTts.isAvailable()) {
            const audioBuf = await voiceTts.synthesizeSpeech(result.text);
            await signalAdapter.sendMessage(msg.chatId, '', {
              attachments: [audioBuf],
              attachmentNames: ['bianca.mp3'],
            });
            console.log(`[voice] Sent TTS response (${audioBuf.length} bytes)`);
          }
        } catch (ttsErr) {
          console.warn(`[voice] TTS failed: ${ttsErr.message}`);
          // Text response was already sent via streaming — no fallback needed
        }
      }
      state._isVoiceMessage = false;

      if (!result.stopped) {
        appendEntry(chatId, {
          cwd: state.cwd,
          promptSummary: text,
          resultSummary: result.text,
          turnCount: result.numTurns || 0,
        });
        // STREAMING: when streamReplies was on AND any text block was streamed
        // live during the run, the user has already seen the reply piece-by-
        // piece. Skip the final send to avoid duplicating it. If nothing was
        // streamed (e.g., the run produced only tool output, or streaming was
        // bypassed for some reason), fall back to sending the full text.
        //
        // Image delivery: use the server-side image registry as PRIMARY source
        // (deterministic — /imagine registers outputs regardless of Claude's text).
        // Union with extractImageAttachments as fallback for non-/imagine images
        // (e.g., images Claude downloads via other tools).
        const imageRegistry = require('./image-registry');
        const registryPaths = imageRegistry.getOutputs(chatId);
        const textPaths = extractImageAttachments(result.text || '');
        const imagePaths = [...new Set([...registryPaths, ...textPaths])];

        if (!result.streamed && result.text) {
          // Strip image file paths from the text — they'll be sent as attachments below
          let textToSend = result.text;
          for (const imgPath of imagePaths) {
            textToSend = textToSend.replace(imgPath, '').trim();
          }
          textToSend = require('./response-filter').stripNoResponse(textToSend);
          if (textToSend) await signalAdapter.sendLongMessage(msg.chatId, textToSend);
        } else if (!result.streamed && !result.text && result.hitTurnLimit) {
          await signalAdapter.sendMessage(msg.chatId, 'I ran out of turns before I could respond — try again or simplify your request.');
        }
        // If no text and no turn limit, silently skip — don't send a placeholder
        if (imagePaths && imagePaths.length > 0) {
          for (const imgPath of imagePaths) {
            try {
              const imgBuf = fs.readFileSync(imgPath);
              const imgName = path.basename(imgPath);
              await signalAdapter.sendMessage(msg.chatId, '', {
                attachments: [imgBuf],
                attachmentNames: [imgName],
              });
            } catch (imgErr) {
              console.warn(`[signal] Failed to send image attachment ${imgPath}: ${imgErr.message}`);
            }
          }
        }
      }
    } catch (err) {
      // Change 4: Queue timeout feedback — non-owners waiting >30s get a friendly busy message
      if (err && err.name === 'SlotTimeoutError') {
        console.log(`[signal] SlotTimeoutError for ${_redactId(msg.senderId)} in ${_redactId(chatId)}`);
        await signalAdapter.sendMessage(msg.chatId, "I'm handling a few conversations right now — try again in a minute");
      } else {
        console.error(`[signal] Error: ${err.message}`);
        console.error(`[signal] Stack: ${err.stack}`);
        await signalAdapter.sendMessage(msg.chatId, `Error: ${err.message.substring(0, 500)}`);
        sendErrorAlert(err, { source: 'signal handler', channel: chatId });
      }
    } finally {
      clearInterval(signalTypingInterval);
      state.busy = false;
      state.startedAt = null;
      state.progress = freshProgress();
      state.activeTask = null;
      // Clean up image registry for this session so it doesn't leak into a later request
      require('./image-registry').end(chatId);
      saveChannelState(chatId, state, { critical: true });
      // Drain queue
      if (state.queue.length > 0) {
        await processQueue(state);
        // processQueue clears in-memory state; re-persist so disk matches.
        saveChannelState(chatId, state, { critical: true });
      }
      // Start session inactivity timer now that bot is idle
      _resetSessionInactivityTimer(state, chatId);
    }
}

/**
 * Create a proxy object that looks enough like a Discord message for handleCommand().
 * Maps reply/channel.send calls to Signal sends.
 */
function createSignalMessageProxy(msg, chatId, state) {
  const reply = (content) => {
    const text = typeof content === 'string' ? content : content.content || '';
    return signalAdapter.sendMessage(msg.chatId, text);
  };

  return {
    content: msg.text,
    author: { id: msg.senderId, bot: false, username: msg.senderName },
    channel: {
      id: chatId,
      send: reply,
      sendTyping: () => Promise.resolve(),
    },
    reply,
    _signalSenderId: msg.senderId, // used by wizards/onComplete to key profile saves
    _signalChatId: msg.chatId,
    _signalMentions: msg.mentions || [], // for !onboard target resolution
    _signalBotPhone: signalAdapter?.phoneNumber || null,
    _signalRaw: msg.raw || null, // for UUID/phone extraction in commands
  };
}

function start() {
  // Signal-only. startSignalAdapter() will call startBot() once the adapter is
  // ready. We also schedule a fallback startBot() invocation in case Signal
  // never comes online (e.g. SIGNAL_PHONE_NUMBER unset) — startBot() is
  // idempotent so the second call is a no-op when the first already ran.
  startSignalAdapter();
  setTimeout(() => { startBot().catch(err => console.error('[startBot] fallback failed:', err.message)); }, 15000);
}

module.exports = { start, askClaude, runClaudeWithContinuation, getChannelState, getPersonalityFile, sendLongMessage, freshProgress, channels, signalAdapter, _tryUnlock, _isChannelElevated, _addKnownGroupMember, _dispatchSignalMessage };
