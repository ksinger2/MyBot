const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
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
const { handleComponentInteraction } = require('./discord-components');
let startSocialPlanWizard, processSocialPlanStep;
try { ({ startSocialPlanWizard, processSocialPlanStep } = require('./wizards/social-plan')); } catch {}
let spotifyAuth;
try { spotifyAuth = require('./spotify-auth'); } catch {}
const { Runner } = require('./runner');
const { sweepOrphanTmpFiles } = require('./atomic-write');
const { extractImageAttachments } = require('./adapters/base');
const { DiscordAdapter } = require('./adapters/discord');
const { loadCommands } = require('./commands');

// F23: Module-level DiscordAdapter instance — all Discord sends route through this
let discordAdapter = null;

// F23: Convenience helpers — route through adapter when available, fall back to raw Discord.js
function _isSignalProxy(message) { return !!message._signalSenderId; }
async function _dsend(channel, text) {
  if (discordAdapter && typeof channel.id === 'string' && !channel.id.startsWith('signal:'))
    return discordAdapter.sendMessage(channel.id, text);
  return channel.send(text);
}
async function _dreply(message, text) {
  if (discordAdapter && !_isSignalProxy(message))
    return discordAdapter.sendMessage(message.channel.id, text, { rawMessage: message });
  return message.reply(text);
}
async function _dtyping(channel) {
  if (discordAdapter && typeof channel.id === 'string' && !channel.id.startsWith('signal:'))
    return discordAdapter.sendTyping(channel.id);
  return channel.sendTyping();
}

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
const _elevatedChannels = new Set();

function _isChannelElevated(channelId) {
  if (!BOT_UNLOCK_PIN) return true; // gate disabled → always elevated
  return _elevatedChannels.has(channelId);
}

function _tryUnlock(channelId, suppliedPin) {
  if (!BOT_UNLOCK_PIN) return true;
  if (typeof suppliedPin !== 'string' || suppliedPin.length === 0) return false;
  const crypto = require('crypto');
  const a = Buffer.from(BOT_UNLOCK_PIN);
  const b = Buffer.from(suppliedPin);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  _elevatedChannels.add(channelId);
  console.log(`[unlock] Channel ${channelId} elevated to full write access`);
  return true;
}

// Access control — comma-separated Discord user IDs.
// SECURITY: fail-closed. Empty set = deny all (NOT allow all as it used to).
// If you're locked out on first boot, set ADMIN_USER_IDS / ALLOWED_USER_IDS in .env.
const ALLOWED_USER_IDS = new Set((process.env.ALLOWED_USER_IDS || '').split(',').filter(Boolean));
const ADMIN_USER_IDS = new Set((process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean));
if (ADMIN_USER_IDS.size === 0) {
  console.warn('[security] WARNING: ADMIN_USER_IDS is empty — no Discord users can run admin commands. Set ADMIN_USER_IDS in .env.');
}
if (ALLOWED_USER_IDS.size === 0 && ADMIN_USER_IDS.size === 0) {
  console.warn('[security] WARNING: ALLOWED_USER_IDS and ADMIN_USER_IDS are both empty — NO Discord user will be allowed to talk to the bot. Set ALLOWED_USER_IDS (and/or ADMIN_USER_IDS) in .env.');
}
function isAllowed(userId) {
  if (!userId) return false;
  // Admin always implies allowed. Otherwise must be in the explicit allow-list.
  if (ADMIN_USER_IDS.has(userId)) return true;
  return ALLOWED_USER_IDS.has(userId);
}
function isAdmin(userId) {
  if (!userId) return false;
  return ADMIN_USER_IDS.has(userId);
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
  name: 'My Bot',
  description: 'a helpful AI assistant on Discord. You are friendly, concise, and capable.'
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

  /** Create a ChannelProxy from a Discord message.channel object */
  static fromDiscord(channel) {
    // F23: Route through DiscordAdapter when available for symmetry with Signal path
    if (discordAdapter) {
      return new ChannelProxy({
        sendFn: (text) => discordAdapter.sendMessage(channel.id, text).then(r => r),
        typingFn: () => discordAdapter.sendTyping(channel.id),
        platform: 'discord',
        chatId: channel.id,
      });
    }
    return new ChannelProxy({
      sendFn: (text) => channel.send(text),
      typingFn: () => channel.sendTyping(),
      platform: 'discord',
      chatId: channel.id,
    });
  }

  /** Create a ChannelProxy for a Signal conversation */
  static fromSignal(adapter, recipientChatId) {
    return new ChannelProxy({
      sendFn: (text) => adapter.sendMessage(recipientChatId, text),
      typingFn: () => Promise.resolve(), // Signal doesn't have typing indicators for bots
      platform: 'signal',
      chatId: recipientChatId,
    });
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

// Per-channel state
const channels = new Map();

// Graceful shutdown — kill children, persist state, then exit
async function gracefulShutdown(signal) {
  console.log(`[shutdown] Received ${signal}, killing children and persisting state...`);
  const killPromises = [];
  for (const [channelId, state] of channels) {
    if (state.process) killPromises.push(forceKillProcess(state.process, 3000));
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
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Detect active participants in a channel by scanning recent messages
async function getChannelParticipants(channel, excludeBots = true) {
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const userIds = new Set();
    for (const [, msg] of messages) {
      if (excludeBots && msg.author.bot) continue;
      userIds.add(msg.author.id);
    }
    return [...userIds];
  } catch { return []; }
}

function getChannel(channelId) {
  if (!channels.has(channelId)) {
    // Check for persisted state from previous container lifecycle
    const saved = _savedChannelStates?.[channelId];
    channels.set(channelId, {
      _channelId: channelId, // stored for journal lookups
      sessionId: saved?.sessionId || null,
      personality: saved?.personality || DEFAULT_PERSONALITY,
      identity: saved?.identity ? { ...saved.identity } : { ...DEFAULT_IDENTITY },
      cwd: saved?.cwd || DEFAULT_WORKSPACE,
      config: saved?.config || {},  // per-channel overrides (maxTurns, maxContinues, maxTimeout)
      listenToAll: saved?.listenToAll || false, // when true, respond to all group messages (not just mentions)
      process: null,  // active child process
      busy: false,    // is Claude currently working
      wizard: null,   // active wizard state (multi-step interactions)
      startedAt: null, // timestamp when Claude started working
      progress: freshProgress(), // structured progress for !btw
      queue: [],      // queued messages while Claude is busy
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

function askClaude(prompt, { sessionId = null, personalityFile = null, identity = null, cwd = DEFAULT_WORKSPACE, maxTurns = null, channelState = null, discordChannel = null, channelProxy = null, discordUserId = null, readOnly = false, groupAllowedTools = undefined, profileContext = null, streamReplies = false } = {}) {
  // Wrap raw Discord channel in ChannelProxy if needed
  if (!channelProxy && discordChannel) {
    channelProxy = ChannelProxy.fromDiscord(discordChannel);
  }
  // Delegate to Runner (extracted in F20/F21)
  const runner = new Runner(prompt, {
    sessionId, personalityFile, identity, cwd, maxTurns,
    channelState, channelProxy, discordUserId, readOnly,
    groupAllowedTools, profileContext, streamReplies,
    // Inject bot.js functions so runner.js doesn't need to import bot.js
    freshProgressFn: freshProgress,
    saveChannelStateFn: saveChannelState,
    flushPendingWritesFn: flushPendingWrites,
  });
  return runner.run();
}

async function runClaudeWithContinuation(prompt, opts, channelProxy) {
  let result = await askClaude(prompt, opts);
  let continueCount = 0;
  let totalCost = result.cost || 0;
  let totalTurns = result.numTurns || 0;
  // Track streamed across all sub-runs — if ANY iteration streamed text, the
  // caller should NOT re-send the final result text (it's already in the chat).
  let anyStreamed = !!result.streamed;
  const maxContinues = opts.channelState?.config?.maxContinues || MAX_AUTO_CONTINUES;

  while (result.hitTurnLimit && continueCount < maxContinues && !result.stopped) {
    continueCount++;
    await channelProxy.send(
      `*Turn limit reached (${continueCount}/${maxContinues}) — auto-continuing...*`
    ).catch(() => {});
    result = await askClaude(
      'You hit the turn limit. Continue where you left off. If the task is complete, just summarize what you did.',
      { ...opts, sessionId: result.sessionId }
    );
    totalCost += result.cost || 0;
    totalTurns += result.numTurns || 0;
    if (result.streamed) anyStreamed = true;
  }

  if (result.hitTurnLimit && continueCount >= maxContinues) {
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

async function sendLongMessage(message, text, cwd = DEFAULT_WORKSPACE) {
  if (!text || text.length === 0) {
    await _dreply(message, '*(No output)*');
    return;
  }

  // Resolve relative paths against cwd before scanning
  const resolvedText = text.replace(/(?:^|\s)([\w./][^\s"'`()]*\.(?:png|jpg|jpeg|gif|webp))/gim, (m, p) => {
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    return m.replace(p, abs);
  });

  const imagePaths = extractImageAttachments(resolvedText);

  // F23: Route all sends through the DiscordAdapter when available.
  // Skip for Signal proxy messages — those already go through signalAdapter.
  // The adapter's sendMessage handles AttachmentBuilder creation internally via Buffer,
  // so we read image files into buffers. For non-image file attachments (like full-response.txt),
  // we also pass buffers.
  if (discordAdapter && !_isSignalProxy(message)) {
    const imageBuffers = [];
    const imageNames = [];
    for (const imgPath of imagePaths) {
      try {
        imageBuffers.push(fs.readFileSync(imgPath));
        imageNames.push(path.basename(imgPath));
      } catch (e) { console.error(`[sendLongMessage] Could not read image ${imgPath}: ${e.message}`); }
    }

    const chunks = [];
    if (text.length <= 1900) {
      chunks.push(text);
    } else {
      let r = text;
      while (r.length > 0) {
        if (r.length <= 1990) { chunks.push(r); break; }
        let splitAt = r.lastIndexOf('\n', 1990);
        if (splitAt < 500) splitAt = 1990;
        chunks.push(r.substring(0, splitAt));
        r = r.substring(splitAt);
      }
    }

    // First chunk: reply to original message, include image attachments
    const firstOpts = { rawMessage: message };
    if (imageBuffers.length) {
      firstOpts.attachments = imageBuffers;
      firstOpts.attachmentNames = imageNames;
    }
    await discordAdapter.sendMessage(message.channel.id, chunks[0], firstOpts).catch(e => console.error('Reply failed:', e.message));

    if (chunks.length > 8) {
      for (let i = 1; i < Math.min(chunks.length, 4); i++) {
        await discordAdapter.sendMessage(message.channel.id, chunks[i]).catch(e => console.error('Chunk send failed:', e.message));
      }
      const fullTextBuffer = Buffer.from(text, 'utf-8');
      await discordAdapter.sendMessage(
        message.channel.id,
        `*Response was too long for Discord (${chunks.length} chunks). Full text attached:*`,
        { attachments: [fullTextBuffer], attachmentNames: ['full-response.txt'] }
      ).catch(e => console.error('Attachment send failed:', e.message));
    } else {
      for (let i = 1; i < chunks.length; i++) {
        await discordAdapter.sendMessage(message.channel.id, chunks[i]).catch(e => console.error('Chunk send failed:', e.message));
      }
    }
    return;
  }

  // Legacy path: direct Discord.js calls (fallback when adapter not initialized)
  const files = imagePaths.map(p => new AttachmentBuilder(p));

  const chunks = [];
  let remaining = text.length <= 1900 ? text : (() => {
    let r = text, out = [];
    while (r.length > 0) {
      if (r.length <= 1990) { out.push(r); break; }
      let splitAt = r.lastIndexOf('\n', 1990);
      if (splitAt < 500) splitAt = 1990;
      out.push(r.substring(0, splitAt));
      r = r.substring(splitAt);
    }
    return out;
  })();

  if (typeof remaining === 'string') chunks.push(remaining);
  else chunks.push(...remaining);

  // Send first chunk with any image attachments
  await _dreply(message,{ content: chunks[0], files: files.length ? files : undefined }).catch(e => console.error('Reply failed:', e.message));

  if (chunks.length > 8) {
    // Too many chunks — send first 4 inline, then upload full text as attachment
    for (let i = 1; i < Math.min(chunks.length, 4); i++) {
      await message.channel.send(chunks[i]).catch(e => console.error('Chunk send failed:', e.message));
    }
    const fullTextBuffer = Buffer.from(text, 'utf-8');
    const attachment = new AttachmentBuilder(fullTextBuffer, { name: 'full-response.txt' });
    await message.channel.send({
      content: `*Response was too long for Discord (${chunks.length} chunks). Full text attached:*`,
      files: [attachment],
    }).catch(e => console.error('Attachment send failed:', e.message));
  } else {
    for (let i = 1; i < chunks.length; i++) {
      await message.channel.send(chunks[i]).catch(e => console.error('Chunk send failed:', e.message));
    }
  }
}

/**
 * Parse natural-language frequency into a cron expression
 * Supports: "daily at 9am", "every 2 hours", "weekdays at 8:30am", "monday at 10am", raw cron
 */
function parseFrequency(input) {
  const s = input.trim().toLowerCase();

  // Raw cron expression (5 fields)
  if (/^[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+$/.test(s)) {
    return { cron: s, description: `Cron: ${s}` };
  }

  // "every N hours" or "every N minutes"
  const intervalMatch = s.match(/^every\s+(\d+)\s+(hour|minute|min)s?$/);
  if (intervalMatch) {
    const n = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    if (unit === 'hour') {
      return { cron: `0 */${n} * * *`, description: `Every ${n} hour(s)` };
    } else {
      return { cron: `*/${n} * * * *`, description: `Every ${n} minute(s)` };
    }
  }

  // Parse time from strings like "at 9am", "at 8:30pm", "at 14:00"
  function parseTime(str) {
    const timeMatch = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!timeMatch) return null;
    let hour = parseInt(timeMatch[1], 10);
    const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  // "daily at TIME"
  const dailyMatch = s.match(/^daily\s+at\s+(.+)$/);
  if (dailyMatch) {
    const time = parseTime(dailyMatch[1]);
    if (time) return { cron: `${time.minute} ${time.hour} * * *`, description: `Daily at ${dailyMatch[1].trim()}` };
  }

  // "weekdays at TIME"
  const weekdayMatch = s.match(/^weekdays?\s+at\s+(.+)$/);
  if (weekdayMatch) {
    const time = parseTime(weekdayMatch[1]);
    if (time) return { cron: `${time.minute} ${time.hour} * * 1-5`, description: `Weekdays at ${weekdayMatch[1].trim()}` };
  }

  // "weekends at TIME"
  const weekendMatch = s.match(/^weekends?\s+at\s+(.+)$/);
  if (weekendMatch) {
    const time = parseTime(weekendMatch[1]);
    if (time) return { cron: `${time.minute} ${time.hour} * * 0,6`, description: `Weekends at ${weekendMatch[1].trim()}` };
  }

  // "DAYNAME at TIME" (e.g. "monday at 10am", "tuesday at 3:30pm")
  const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const dayMatch = s.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\s+at\s+(.+)$/);
  if (dayMatch) {
    const dayNum = days[dayMatch[1]];
    const time = parseTime(dayMatch[2]);
    if (time) return { cron: `${time.minute} ${time.hour} * * ${dayNum}`, description: `${dayMatch[1].charAt(0).toUpperCase() + dayMatch[1].slice(1)}s at ${dayMatch[2].trim()}` };
  }

  // "at TIME" (assume daily)
  const atMatch = s.match(/^at\s+(.+)$/);
  if (atMatch) {
    const time = parseTime(atMatch[1]);
    if (time) return { cron: `${time.minute} ${time.hour} * * *`, description: `Daily at ${atMatch[1].trim()}` };
  }

  return null;
}

// ── Command dispatch ──────────────────────────────────────────────────────────
// Commands are loaded from claude-api/commands/*.js. Each exports
// { name, aliases?, adminOnly?, description, run(message, arg, state, ctx) }.
// The ctx object passes bot.js internals to command handlers.

const commands = loadCommands();

function buildCommandCtx() {
  return {
    // Discord client & channel state
    client, channels, getChannel, saveChannelState, flushPendingWrites,
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
    // Access control
    isAdmin, isAllowed,
    // F23 adapter helpers
    _dsend, _dreply, _dtyping,
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
  // `_signalSenderId`; for Signal, admin = `isSignalOwner(senderId)`. Discord
  // uses the fail-closed ADMIN_USER_IDS allowlist.
  if (cmd.adminOnly) {
    let isAdminCaller;
    if (message._signalSenderId) {
      const { isSignalOwner } = require('./project-permissions');
      isAdminCaller = isSignalOwner(message._signalSenderId);
    } else {
      isAdminCaller = isAdmin(message.author.id);
    }
    if (!isAdminCaller) {
      await _dreply(message, '🚫 Owner only — that command requires admin access.');
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

client.on('error', (err) => {
  console.error('Discord client error:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  sendErrorAlert(err instanceof Error ? err : new Error(String(err)), { source: 'unhandledRejection' });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  sendErrorAlert(err, { source: 'uncaughtException' });
});

client.on('clientReady', () => {
  // F23: Initialize DiscordAdapter wrapping the existing client (avoids a second Client instance).
  // From this point, sendMessage/sendLongMessage/sendTyping go through the adapter for symmetry
  // with the Signal path.
  discordAdapter = new DiscordAdapter({ client });
  discordAdapter.ready = true;
  module.exports.discordAdapter = discordAdapter;

  // F16: sweep orphaned .tmp files from previous crash before reading stores
  try { sweepOrphanTmpFiles(['/app/data', '/home/node/.claude']); } catch {}

  // F17: boot warnings for hardcoded fallbacks
  if (!process.env.HOST_HOME) console.warn('[security] WARNING: HOST_HOME not set in .env — falling back to hardcoded default /home/karen. Set HOST_HOME in .env if your home directory differs.');
  if (!process.env.SIGNAL_OWNER_NUMBER) console.warn('[security] WARNING: SIGNAL_OWNER_NUMBER not set in .env — falling back to hardcoded default. Set SIGNAL_OWNER_NUMBER in .env.');

  console.log(`Discord bot logged in as ${client.user.tag}`);
  console.log(`Bot is in ${client.guilds.cache.size} server(s)`);
  client.guilds.cache.forEach(g => console.log(` - ${g.name} (${g.id})`));
  console.log(`Default personality: ${DEFAULT_PERSONALITY}`);
  console.log(`Workspace: ${DEFAULT_WORKSPACE}`);
  console.log(`Max turns: ${DEFAULT_MAX_TURNS} | Timeout: ${MAX_TIMEOUT / 60000}min`);
  if (BOT_UNLOCK_PIN) {
    console.log('[security] !unlock PIN gate is ACTIVE — channels start read-only (chat/search/browse OK, file edits blocked). Send !unlock <PIN> to elevate.');
  } else {
    console.log('[security] !unlock PIN gate is disabled (BOT_UNLOCK_PIN not set).');
  }

  // Restore persisted channel states from previous container lifecycle
  _savedChannelStates = loadAllChannelStates();
  const savedCount = Object.keys(_savedChannelStates).length;
  if (savedCount > 0) {
    console.log(`Restored ${savedCount} channel state(s) from persistence`);
    // Pre-populate channels Map so !status shows them
    for (const channelId of Object.keys(_savedChannelStates)) {
      getChannel(channelId);
    }
  }

  // Notify channel if we're coming back from a !restart
  const restartFile = path.join(__dirname, '.restart-channel');
  if (fs.existsSync(restartFile)) {
    try {
      const channelId = fs.readFileSync(restartFile, 'utf-8').trim();
      fs.unlinkSync(restartFile);
      const ch = client.channels.cache.get(channelId);
      if (ch) _dsend(ch, "I'm back! Restart complete.").catch(() => {});
    } catch {}
  }

  // Initialize error alerting
  initErrorAlerting(client);

  // Check if we recovered from a crash loop via automatic rollback
  const rolledBackMarker = '/tmp/.rolled-back';
  let wasRolledBack = false;
  if (fs.existsSync(rolledBackMarker)) {
    wasRolledBack = true;
    try {
      fs.unlinkSync(rolledBackMarker);
      sendErrorAlert(new Error('Automatic rollback triggered — bot crash-looped after a rebuild and was restored to the last known good version. The bad code changes are still in /workspace/MyBot/claude-api/ and need to be fixed.'));
      console.log('[entrypoint] Recovered from crash loop via automatic rollback');
    } catch {}
  }

  // Check if this was a clean shutdown (!restart) vs a crash
  const cleanShutdownFile = path.join('/home/node/.claude', '.clean-shutdown');
  const wasCleanShutdown = fs.existsSync(cleanShutdownFile);
  if (wasCleanShutdown) {
    try { fs.unlinkSync(cleanShutdownFile); } catch {}
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

  // Start scheduled briefings
  const briefings = require('./briefings');
  briefings.startScheduler(client);

  // Start AI news pulse (every 3 hours)
  const aiNews = require('./ai-news');
  aiNews.startAINewsScheduler(client);

  // Start user-created schedules
  startAllSchedules(client);

  // Start background task queue runner
  const { startQueueRunner } = require('./queue-runner');
  startQueueRunner(client);

  // Start event monitors (CI, health checks)
  const { startMonitorRunner } = require('./monitor-runner');
  startMonitorRunner(client);

  // Auto-resume interrupted work after a crash (not a clean !restart)
  // All channels resume IN PARALLEL so one doesn't block the others
  if (!wasCleanShutdown && !wasRolledBack) {
    setTimeout(() => {
      // A channel needs notification if EITHER:
      //   (a) it had an activeTask in flight when we went down, OR
      //   (b) it had a non-empty pendingQueue (user messages we never got to), OR
      //   (c) it was explicitly flagged by /rebuild via wantsRestartNotification
      // The user's complaint was that channels mid-conversation got silent
      // restarts — case (b)/(c) ensure we always announce when there was
      // active back-and-forth, not just an unfinished task.
      const channelsToNotify = Object.entries(_savedChannelStates).filter(([, s]) => {
        if (!s) return false;
        if (s.activeTask) return true;
        if (s.pendingQueue && s.pendingQueue.length > 0) return true;
        if (s.wantsRestartNotification) return true;
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
    }, 10000); // 10s delay for Discord cache to populate
  }
});

async function resumeChannel(channelId, savedState) {
  const task = savedState.activeTask;
  const state = getChannel(channelId);

  // Build the restart notification message. We show whatever signal we have
  // about what was happening so the user knows WHY the bot went silent and
  // what (if anything) they should resend.
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
        ? `*Back online — I just rebuilt myself. Mid-rebuild I was working on: "${summary}". If anything you sent didn't get answered, resend it now.*`
        : `*Back online — I just rebuilt myself. If anything you sent didn't get answered, resend it now.*`;
    }
    return summary
      ? `*I'm back from an unexpected restart. I was working on: "${summary}" — that got interrupted. Resend if you still need it.*`
      : `*I'm back from an unexpected restart. Anything you sent in the last few minutes may have been dropped — resend if you still need it.*`;
  }

  // Signal-aware path: notify the Signal user via the adapter. We don't try
  // to actually re-run the previous task — that's risky if it was the cause
  // of a crash. Just acknowledge that the bot is back and the user should
  // resend if needed.
  if (channelId.startsWith('signal:')) {
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
    return;
  }

  // Discord path with no resumable task: just send a notification and bail.
  // This catches the case where the channel had a pending queue but the
  // activeTask was already cleared (e.g. between turns when /rebuild fired).
  if (!task) {
    state.busy = false;
    state.wantsRestartNotification = null;
    saveChannelState(channelId, state, { critical: true });
    const ch = client.channels.cache.get(channelId);
    if (ch) {
      _dsend(ch, buildRestartMessage()).catch(() => {});
      console.log(`[auto-resume] Notified Discord channel ${channelId} of restart (no resumable task)`);
    }
    return;
  }

  // Safety: don't retry more than 2 times
  if ((task.resumeAttempts || 0) >= 2) {
    console.log(`[auto-resume] Giving up on channel ${channelId} after ${task.resumeAttempts} attempts`);
    state.activeTask = null;
    state.busy = false;
    saveChannelState(channelId, state, { critical: true });
    const ch = client.channels.cache.get(channelId);
    if (ch) _dsend(ch, '*I crashed while working and failed to resume after 2 attempts. Send your request again if needed.*').catch(() => {});
    return;
  }

  // Look up the channel BEFORE marking busy. If we can't find it we must NOT
  // strand state.busy = true, or every subsequent message will be queued forever.
  const ch = client.channels.cache.get(channelId);
  if (!ch) {
    console.log(`[auto-resume] Channel ${channelId} not in cache, clearing stale activeTask`);
    state.activeTask = null;
    state.busy = false;
    saveChannelState(channelId, state, { critical: true });
    return;
  }

  // CRITICAL: Set busy immediately before any async work to prevent race
  state.busy = true;

  // Increment attempt counter
  task.resumeAttempts = (task.resumeAttempts || 0) + 1;
  state.activeTask = task;
  saveChannelState(channelId, state);
  flushPendingWrites();

  console.log(`[auto-resume] Resuming work in channel ${channelId} (attempt ${task.resumeAttempts}/2)`);
  await _dsend(ch, `*I crashed while working on your request. Resuming now... (attempt ${task.resumeAttempts}/2)*`).catch(() => {});
  await _dtyping(ch).catch(() => {});
  const typingInterval = setInterval(() => _dtyping(ch).catch(() => {}), 8000);

  const pendingQueue = savedState.pendingQueue || [];
  let resumePrompt = 'You were interrupted by a system crash. Continue where you left off. If you were nearly done, just wrap up and summarize what you accomplished.';
  if (pendingQueue.length > 0) {
    resumePrompt += '\n\n[Messages from user while you were working]\n' + pendingQueue.map(q => `- ${q}`).join('\n');
  }

  const personalityFile = getPersonalityFile(state.personality);

  try {
    state.busy = true;
    state.startedAt = Date.now();
    state.progress = freshProgress();

    let result;
    try {
      result = await runClaudeWithContinuation(resumePrompt, {
        sessionId: state.sessionId,
        personalityFile,
        identity: state.identity,
        cwd: state.cwd,
        channelState: state,
        discordChannel: ch,
      }, ChannelProxy.fromDiscord(ch));
    } catch (err) {
      // If session resume fails, try fresh with the original prompt
      if (state.sessionId) {
        console.log(`[auto-resume] Session resume failed for ${channelId}, retrying fresh:`, err.message);
        state.sessionId = null;
        result = await askClaude(
          `[Resuming after crash — original request was: "${task.prompt}"]\n\nCheck the current state of the project and continue or complete this work. If it appears already done, just confirm.`,
          { personalityFile, identity: state.identity, cwd: state.cwd, channelState: state, discordChannel: ch }
        );
      } else {
        throw err;
      }
    }

    if (result.sessionId) {
      state.sessionId = result.sessionId;
      saveChannelState(channelId, state);
    }

    if (!result.stopped && result.text) {
      appendEntry(channelId, {
        cwd: state.cwd,
        promptSummary: '[auto-resume] ' + task.prompt,
        resultSummary: result.text,
        turnCount: result.numTurns || 0,
      });
      // Send result to the channel directly — F23: route through adapter
      const lines = result.text.split('\n');
      let chunk = '';
      for (const line of lines) {
        if ((chunk + '\n' + line).length > 1990) {
          await _dsend(ch, chunk).catch(() => {});
          chunk = line;
        } else {
          chunk = chunk ? chunk + '\n' + line : line;
        }
      }
      if (chunk) await _dsend(ch, chunk).catch(() => {});
    }

    // Success — clear active task
    state.activeTask = null;
    saveChannelState(channelId, state);
    console.log(`[auto-resume] Successfully resumed work in channel ${channelId}`);
  } catch (err) {
    console.error(`[auto-resume] Failed for channel ${channelId}:`, err.message);
    await _dsend(ch, `*Auto-resume failed: ${err.message.substring(0, 200)}. Send another message to retry manually.*`).catch(() => {});
    sendErrorAlert(err, { source: 'auto-resume', channel: channelId });
  } finally {
    clearInterval(typingInterval);
    state.busy = false;
    state.startedAt = null;
    state.progress = freshProgress();
  }
}

async function processQueue(state) {
  if (!state.queue.length) return;

  // CRITICAL: Set busy BEFORE splicing to prevent race with incoming messages
  state.busy = true;

  // Combine all queued messages into one prompt
  const queued = state.queue.splice(0);
  const combined = queued.length === 1
    ? queued[0].content
    : '[Additional messages from user while you were working]\n' + queued.map(q => `- ${q.content}`).join('\n');

  // Reply threaded to the last queued message
  const replyTarget = queued[queued.length - 1].message;
  const personalityFile = getPersonalityFile(state.personality);

  await _dtyping(replyTarget.channel);
  const typingInterval = setInterval(() => {
    _dtyping(replyTarget.channel).catch(() => {});
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
      discordChannel: replyTarget.channel,
    };
    try {
      result = await runClaudeWithContinuation(combined, queueOpts, ChannelProxy.fromDiscord(replyTarget.channel));
    } catch (err) {
      if (state.sessionId) {
        console.log('Session resume failed in queue, retrying fresh:', err.message);
        state.sessionId = null;
        result = await askClaude(combined, {
          personalityFile,
          identity: state.identity,
          cwd: state.cwd,
          channelState: state,
          discordChannel: replyTarget.channel,
        });
      } else {
        throw err;
      }
    }

    if (result.sessionId) {
      state.sessionId = result.sessionId;
      saveChannelState(replyTarget.channel.id, state);
    }

    if (result.stopped) {
      if (!state._userStopped) {
        await _dsend(replyTarget.channel, '*Process was interrupted unexpectedly — I stopped without finishing. Send another message to continue.*').catch(() => {});
      }
      state._userStopped = false;
    } else {
      appendEntry(replyTarget.channel.id, {
        cwd: state.cwd,
        promptSummary: combined,
        resultSummary: result.text,
        turnCount: result.numTurns || 0,
      });
      await sendLongMessage(replyTarget, result.text, state.cwd);

      // Completion summary for non-trivial tasks
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
        await _dsend(replyTarget.channel, `*— ${parts.join(' · ')} —*`).catch(() => {});
      }

      const meta = [];
      if (result.numTurns > 1) meta.push(`${result.numTurns} turns`);
      if (result.cost) meta.push(`$${result.cost.toFixed(4)}`);
      if (meta.length) console.log(`Queue completed: ${meta.join(' | ')}`);
    }
  } catch (err) {
    console.error('Error processing queued message:', err.message);
    const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
    await replyTarget.reply(`Error: ${errorMsg}`).catch(() => {});
    sendErrorAlert(err, { source: 'queue handler', channel: replyTarget.channel.id });
  } finally {
    clearInterval(typingInterval);
    state.busy = false;
    state.startedAt = null;
    state.progress = freshProgress();
    state.activeTask = null;
    // Persist cleared state — otherwise disk still shows pendingQueue/activeTask
    // and the next restart will trigger spurious auto-resume.
    const persistChannelId = state._channelId || replyTarget?.channel?.id;
    if (persistChannelId) {
      saveChannelState(persistChannelId, state, { critical: true });
    }
    // Recursively drain if more messages came in during processing
    await processQueue(state);
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Access control — reject unauthorized users
  if (!isAllowed(message.author.id)) return;

  // In guild channels, only respond when @mentioned (or a ! command)
  const isGuild = !!message.guild;
  const isMentioned = message.mentions.has(client.user);

  // F1: diagnostic logging — every guild message reaches the handler.
  // Without this we cannot tell if mentions are detected, content is empty, etc.
  if (isGuild) {
    console.log(`[discord-msg] guild=${message.guild.id} ch=${message.channel.id} user=${message.author.tag} mentions=${message.mentions.size} contentLen=${message.content.length} isMentioned=${isMentioned}`);
  }

  // F3: detect MESSAGE_CONTENT privileged-intent failure. If a guild message
  // arrives with empty content + no attachments + no embeds + no mentions, the
  // dev portal MESSAGE_CONTENT toggle is almost certainly off. Log loudly, once.
  if (isGuild && !message.content && message.attachments.size === 0 && (!message.embeds || message.embeds.length === 0) && message.mentions.size === 0) {
    if (!global.__messageContentIntentWarned) {
      global.__messageContentIntentWarned = true;
      console.error('[CRITICAL] Guild message has empty content and no other payload — the MESSAGE_CONTENT privileged intent is almost certainly disabled in the Discord developer portal. Fix: https://discord.com/developers/applications → your bot → Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT.');
    }
  }

  if (isGuild && !isMentioned && !message.content.startsWith('!')) {
    const guildState = getChannel(message.channel.id);
    if (!guildState.listenToAll) return;
  }

  // Strip the @mention prefix from message content so Claude doesn't see it
  if (isGuild && isMentioned) {
    message.content = message.content.replace(/<@!?\d+>/g, '').trim();
    // F2: mention-only messages would otherwise be silently dropped by the
    // empty-content check below. Use a friendly default so the bot still replies.
    if (!message.content) message.content = 'hi';
  }

  const state = getChannel(message.channel.id);

  // Handle commands — also cancel any active wizard when a command is issued
  if (message.content.startsWith('!')) {
    if (state.wizard && message.content.trim().toLowerCase() !== '!cancel') {
      state.wizard = null; // silently cancel wizard on any command
    }
    try {
      const handled = await handleCommand(message);
      if (handled) return;
    } catch (err) {
      console.error('Command error:', err.message);
      await _dreply(message, `Command failed: ${err.message}`).catch(() => {});
      return;
    }
  }

  // Handle pending preview device selection
  if (state._pendingPreview) {
    const reply = message.content.trim().toLowerCase();
    const port = state._pendingPreview;
    if (['local', 'localhost', 'pc', 'computer', 'same'].includes(reply)) {
      state._pendingPreview = null;
      await _dreply(message,`**Open on this PC:** http://localhost:${port}`);
      return;
    }
    if (['phone', 'mobile', 'tablet', 'remote', 'tunnel'].includes(reply)) {
      state._pendingPreview = null;
      // Reuse the !preview <port> phone flow by simulating the command
      message.content = `!preview ${port} phone`;
      await handleCommand(message);
      return;
    }
    // Cancel if they type something unrelated
    if (reply.startsWith('!')) {
      state._pendingPreview = null;
      // fall through to normal command handling (already handled above)
    }
  }

  // If a wizard is active, let it handle the message
  if (state.wizard) {
    // Run async step processing for social-plan and hangout wizards
    if (processSocialPlanStep && state.wizard.type === 'social-plan') {
      try { await processSocialPlanStep(state, message); } catch {}
    }
    if (state.wizard?.type === 'hangout') {
      try { await processHangoutStep(state, message); } catch {}
    }
    const handled = await handleWizardMessage(state, message);
    if (handled) return;
  }

  // Ignore empty messages (e.g. stickers, attachments with no text)
  if (!message.content.trim()) return;

  // F10: Deterministic greeting fast-path for Discord too
  const discordText = message.content.trim();
  if (discordText.length < 50 && GREETING_RE.test(discordText) && !discordText.startsWith('!')) {
    const personality = state.personality || DEFAULT_PERSONALITY;
    // F23: Route through adapter
    if (discordAdapter) {
      await discordAdapter.sendMessage(message.channel.id, _pickGreetingResponse(personality), { rawMessage: message });
    } else {
      await _dreply(message,_pickGreetingResponse(personality));
    }
    return;
  }

  // If Claude is already working, queue the message.
  // L-Fix-2: a !loop holds state.busy=true for its whole duration, so messages
  // sent during a loop fall into this path and get queued. processQueue won't
  // run them until the loop's outer finally clears state.busy.
  if (state.busy) {
    state.queue.push({ message, content: message.content });
    saveChannelState(message.channel.id, state, { critical: true }); // persist queue immediately
    const pos = state.queue.length;
    const ctx = state.loopActive ? ' (loop in progress — use `!stop` to interrupt)' : '';
    // F23: Route through adapter
    const queueMsg = pos >= 5
      ? `Queued (#${pos}) — queue is getting long. Use \`!stop\` to interrupt if needed.${ctx}`
      : `Queued (#${pos}) — I'll get to that next.${ctx}`;
    if (discordAdapter) {
      await discordAdapter.sendMessage(message.channel.id, queueMsg, { rawMessage: message });
    } else {
      await _dreply(message,queueMsg);
    }
    return;
  }

  const personalityFile = getPersonalityFile(state.personality);

  // Keep typing indicator alive — F23: route through adapter
  const _channelId = message.channel.id;
  if (discordAdapter) {
    await discordAdapter.sendTyping(_channelId);
  } else {
    await message.channel.sendTyping();
  }
  const typingInterval = setInterval(() => {
    if (discordAdapter) discordAdapter.sendTyping(_channelId).catch(() => {});
    else message.channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    // Track active task so we can resume after crash/restart
    state.activeTask = {
      prompt: message.content.substring(0, 500),
      channelId: message.channel.id,
      startedAt: new Date().toISOString(),
      resumeAttempts: 0,
    };
    saveChannelState(message.channel.id, state, { critical: true });

    let result;
    // Auto-detect social/location links — pre-fetch metadata and build action prompt
    const detectedLinks = detectLinks(message.content);
    let messagePrompt = message.content;
    if (detectedLinks.length > 0) {
      const enriched = await enrichLinks(detectedLinks);
      messagePrompt = buildSmartPrompt(enriched) + message.content;
    }

    const claudeOpts = {
      sessionId: state.sessionId,
      personalityFile,
      identity: state.identity,
      cwd: state.cwd,
      channelState: state,
      discordChannel: message.channel,
      discordUserId: message.author.id,
      // Sudo-style PIN gate: when BOT_UNLOCK_PIN is set, Claude starts in
      // read-only mode (can chat/search/browse but not Edit/Write/Bash) until
      // the channel is elevated via !unlock <PIN>.
      readOnly: !_isChannelElevated(message.channel.id),
    };
    try {
      result = await runClaudeWithContinuation(messagePrompt, claudeOpts, ChannelProxy.fromDiscord(message.channel));
    } catch (err) {
      if (state.sessionId) {
        console.log('Session resume failed, retrying fresh:', err.message);
        state.sessionId = null;
        await _dsend(message.channel, '*Session error — retrying fresh (1/2)...*').catch(() => {});
        try {
          result = await askClaude(message.content, {
            personalityFile,
            identity: state.identity,
            cwd: state.cwd,
            channelState: state,
            discordChannel: message.channel,
          });
        } catch (freshErr) {
          // Fresh call also failed — wait 3s and try once more
          console.log('Fresh call also failed, retrying after delay:', freshErr.message);
          await _dsend(message.channel, '*Still failing — retrying one more time (2/2)...*').catch(() => {});
          await new Promise(r => setTimeout(r, 3000));
          result = await askClaude(message.content, {
            personalityFile,
            identity: state.identity,
            cwd: state.cwd,
            channelState: state,
            discordChannel: message.channel,
          });
        }
      } else {
        // No session — wait 3s and retry once
        console.log('CLI failed, retrying after delay:', err.message);
        await _dsend(message.channel, '*Hit an error — retrying in 3s...*').catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        try {
          result = await askClaude(message.content, {
            personalityFile,
            identity: state.identity,
            cwd: state.cwd,
            channelState: state,
            discordChannel: message.channel,
          });
        } catch (retryErr) {
          throw retryErr;
        }
      }
    }

    // Store session for continuity
    if (result.sessionId) {
      state.sessionId = result.sessionId;
      saveChannelState(message.channel.id, state);
    }

    if (result.stopped) {
      // If stop was NOT initiated by the user (external kill, OOM, container restart), alert them
      if (!state._userStopped) {
        await _dsend(message.channel, '*Process was interrupted unexpectedly ��� I stopped without finishing. Send another message to continue.*').catch(() => {});
      }
      state._userStopped = false;
    } else {
      // Save journal entry so next session (even after restart) knows what happened
      appendEntry(message.channel.id, {
        cwd: state.cwd,
        promptSummary: message.content,
        resultSummary: result.text,
        turnCount: result.numTurns || 0,
      });

      await sendLongMessage(message, result.text, state.cwd);

      // Step 3: Completion summary for non-trivial tasks
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
        // Aggregate tool usage from progress.toolHistory
        const toolCounts = {};
        for (const t of completedProgress.toolHistory) {
          const tName = typeof t === 'string' ? t : t.name;
          toolCounts[tName] = (toolCounts[tName] || 0) + 1;
        }
        const topTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([t, c]) => `${c} ${TOOL_LABELS[t] || t}`).join(', ');
        if (topTools) parts.push(topTools);
        await _dsend(message.channel, `*— ${parts.join(' · ')} —*`).catch(() => {});
      }

      // Show cost and turns info
      const meta = [];
      if (result.numTurns > 1) meta.push(`${result.numTurns} turns`);
      if (result.cost) meta.push(`$${result.cost.toFixed(4)}`);
      if (meta.length) {
        console.log(`Completed: ${meta.join(' | ')}`);
      }
    }
  } catch (err) {
    // Step 4: Error recovery — retry once with session context
    if (state.sessionId && !err.message.includes('stalled') && !state._retried) {
      state._retried = true;
      await _dreply(message, '*Hit an error — retrying with session context...*').catch(() => {});
      try {
        const retryResult = await askClaude(
          'You were interrupted by an error. Continue where you left off. If you were stuck, try a different approach.',
          { sessionId: state.sessionId, personalityFile, identity: state.identity, cwd: state.cwd, channelState: state, discordChannel: message.channel }
        );
        if (retryResult.sessionId) {
          state.sessionId = retryResult.sessionId;
          saveChannelState(message.channel.id, state);
        }
        if (!retryResult.stopped) await sendLongMessage(message, retryResult.text, state.cwd);
        state._retried = false;
        return;
      } catch (retryErr) {
        console.error('Retry also failed:', retryErr.message);
      }
    }
    state._retried = false;

    // Step 3: Richer error messages
    console.error('Error handling message:', err.message);
    const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
    const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
    const errorParts = [];
    if (elapsed > 0) errorParts.push(`Error after ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
    if (state.progress.turnCount > 0) errorParts.push(`${state.progress.turnCount} turns completed`);
    errorParts.push(errorMsg);
    const lastLogs = state.progress.rawLog.slice(-3).map(e => e.text).join('\n');
    if (lastLogs) errorParts.push(`\nLast activity:\n${lastLogs}`);
    if (state.sessionId) errorParts.push('\n*Session preserved — send another message to retry, or `!refresh` to reset everything.*');
    else errorParts.push('\n*Try again, or `!refresh` to reset everything.*');
    await _dreply(message, errorParts.join(' · ')).catch(() => {});
    sendErrorAlert(err, { source: 'message handler', channel: message.channel.id, detail: message.content.substring(0, 100) });
  } finally {
    clearInterval(typingInterval);
    state.busy = false;
    state.startedAt = null;
    state.progress = freshProgress();
    // Clear active task — work is done (or failed)
    state.activeTask = null;
    saveChannelState(message.channel.id, state, { critical: true });
    // Drain queued messages
    await processQueue(state);
  }
});

// Handle Discord button/select menu interactions (for plan components, voting, etc.)
client.on('interactionCreate', async (interaction) => {
  try {
    await handleComponentInteraction(interaction);
  } catch (err) {
    console.error('Interaction error:', err.message);
  }
});

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

  // Access control for Signal — comma-separated phone numbers.
  // SECURITY (H1): fail-closed. Empty = deny all (except the owner, who is
  // always permitted via isSignalOwner). Previously empty = allow all, which
  // meant a misconfigured .env exposed the bot to every Signal number on Earth.
  const allowedNumbers = new Set((process.env.SIGNAL_ALLOWED_NUMBERS || '').split(',').filter(Boolean));
  if (allowedNumbers.size === 0) {
    console.warn('[security] WARNING: SIGNAL_ALLOWED_NUMBERS is empty — only the owner (SIGNAL_OWNER_NUMBER) will be allowed to talk to the bot on Signal. Set SIGNAL_ALLOWED_NUMBERS in .env to permit additional numbers.');
  }

  const { isSignalOwner, hasProjectPermission } = require('./project-permissions');
  const { buildProfileContext, getProfile } = require('./user-profiles');

  signalAdapter.on('message', async (msg) => {
    // Access control — SECURITY (H1): fail-closed. Owner is ALWAYS allowed
    // (even if SIGNAL_ALLOWED_NUMBERS is empty), otherwise must be explicitly
    // listed. Group messages are allowed if the sender is in the allowlist.
    // Access control: owner is always allowed. For non-owners:
    // - GROUP messages: always allowed (if you're in the group, you're trusted)
    // - DM messages: must be in SIGNAL_ALLOWED_NUMBERS (fail-closed for strangers)
    // This lets group members interact with the bot without being individually
    // allowlisted, while still blocking random DMs from unknown numbers.
    const isGroupMessage = msg.chatId !== msg.senderId;
    const senderAllowed = isSignalOwner(msg.senderId) || isGroupMessage || allowedNumbers.has(msg.senderId);
    if (!senderAllowed) {
      console.log(`[signal] blocked DM from non-allowlisted sender ${_redactId(msg.senderId)}`);
      return;
    }

    // Build a synthesized text body that includes attachment file paths so
    // Claude can Read them. The user reported that images sent over Signal
    // were silently dropped — this is the fix: we hand Claude the local
    // path that the adapter just downloaded.
    // Strip U+FFFC (object replacement character) from ALL Signal text, not
    // just the greeting check. Signal inserts ￼ as a placeholder for @mentions.
    // Claude interprets it as a missing image/attachment and goes investigating.
    let text = (msg.text || '').replace(/\uFFFC/g, '').trim();
    const downloadedFiles = (msg.attachments || []).filter(a => a.localPath);
    if (downloadedFiles.length > 0) {
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
      if (!state.listenToAll && !hasPendingSenderWizard) {
        const mentionList = (msg.mentions && msg.mentions.length > 0)
          ? msg.mentions
          : (msg.raw?.envelope?.dataMessage?.mentions || []);
        const botPhone = signalAdapter.phoneNumber;
        const botUuid = signalAdapter._selfUuid || null;
        const botMentioned = mentionList.some(m =>
          (m.number && m.number === botPhone) ||
          (m.uuid && botUuid && m.uuid === botUuid)
        );
        if (!botMentioned) {
          console.log(`[signal] Group message — bot not mentioned, ignoring (${mentionList.length} other mention(s))`);
          return;
        }
      }
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
    const hasSenderWizard = state.senderWizards && state.senderWizards[msg.senderId];
    if (state.wizard || hasSenderWizard) {
      const fakeMessage = createSignalMessageProxy(msg, chatId, state);
      // Allow !cancel to escape the wizard
      if (text.toLowerCase() === '!cancel') {
        await cancelWizard(state, fakeMessage);
        return;
      }
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

    // Handle commands (same !command syntax).
    // Also handle "@BotName !command" — strip the @mention prefix first.
    const cmdText = text.replace(/^@\S+\s+/, '').trim();
    if (cmdText.startsWith('!')) {
      const fakeMessage = createSignalMessageProxy({ ...msg, text: cmdText }, chatId, state);
      const handled = await handleCommand(fakeMessage);
      if (handled) return;
    }

    // If busy, queue the message — silently in group chats, brief ack in DMs
    if (state.busy) {
      const fakeMessage = createSignalMessageProxy(msg, chatId, state);
      state.queue.push({ message: fakeMessage, content: text });
      saveChannelState(chatId, state, { critical: true });
      if (!isGroupMessage) {
        const pos = state.queue.length;
        await signalAdapter.sendMessage(msg.chatId, `Queued (#${pos}) — I'll get to that next.`);
      }
      return;
    }

    // Normal message — run Claude
    const personalityFile = getPersonalityFile(state.personality);
    // Real Signal typing indicator (replaces the old "..." literal-message hack).
    // Signal typing dots auto-expire after a few seconds, so refresh on an interval
    // for the duration of Claude's run.
    await signalAdapter.sendTyping(msg.chatId).catch(() => {});
    const signalTypingInterval = setInterval(() => {
      signalAdapter.sendTyping(msg.chatId).catch(() => {});
    }, 8000);

    try {
      state._isGroupChat = isGroupMessage; // used by commands (e.g. !btw) to suppress in groups
      state.activeTask = {
        prompt: text.substring(0, 500),
        channelId: chatId,
        startedAt: new Date().toISOString(),
        resumeAttempts: 0,
      };
      state.busy = true;
      saveChannelState(chatId, state, { critical: true });

      const signalProxy = ChannelProxy.fromSignal(signalAdapter, msg.chatId);

      // Build profile context. For 1:1 messages, just the sender. For group
      // messages, also list all OTHER known members of the group so the bot
      // can answer things like "plan for us" using everyone's calendars.
      let combinedProfileContext = buildProfileContext(msg.senderId);
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
            const memberIds = (grp.members || []).filter(m => m.startsWith('+') && m !== msg.senderId && m !== signalAdapter.phoneNumber);
            const memberContexts = [];
            for (const mid of memberIds) {
              const ctx = buildProfileContext(mid);
              if (ctx) memberContexts.push(ctx.replace('USER PROFILE (this message is from', 'OTHER GROUP MEMBER ('));
            }
            if (memberContexts.length > 0) {
              const groupHeader = `GROUP CONTEXT — This message is from a Signal group "${grp.name || msg.chatId}" with ${grp.members?.length || '?'} members. Sender is ${msg.senderId}. Other known members:`;
              combinedProfileContext = [
                combinedProfileContext || '',
                groupHeader,
                ...memberContexts,
                'When the user says "us" or "we", coordinate across all known members. Use their Google Calendars (where connected) to find times that work for everyone.',
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
      // sessions from carrying over). Max 5 turns (enough for a useful reply,
      // not enough for a rabbit hole).
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

      const claudeOpts = {
        sessionId: isGroupChat ? null : state.sessionId,
        personalityFile,
        identity: state.identity,
        cwd: state.cwd,
        channelState: state,
        channelProxy: signalProxy,
        discordUserId: msg.senderId,
        // Groups use a SOCIAL allowlist: web search, reading, calendar (Bash for
        // curl), sub-agents — but NOT Edit/Write/Grep/Glob (engineering tools).
        // readOnly=false so the Runner doesn't apply the restrictive readOnly list.
        // Instead we pass a custom groupAllowedTools list.
        readOnly: isGroupChat ? false : (!senderIsOwner || !_isChannelElevated(chatId)),
        groupAllowedTools: isGroupChat ? 'Read,WebSearch,WebFetch,Bash,Task,TodoWrite' : undefined,
        profileContext: (combinedProfileContext || '') + groupOnboardHint + pendingEventContext + (isGroupChat ? `\n\nCHAT_ID: ${msg.chatId}\nSENDER_ID: ${msg.senderId}` : ''),
        streamReplies: true,
        maxTurns: isGroupChat ? 3 : (senderIsOwner ? (parseInt(process.env.SIGNAL_OWNER_MAX_TURNS, 10) || 200) : undefined),
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

      const result = await runClaudeWithContinuation(signalPrompt, claudeOpts, signalProxy);

      // Auto-learn extraction — strip [LEARNED: ...] tags, store preferences, notify user
      const { addPreference } = require('./user-profiles');
      const learnedRe = /\[LEARNED:\s*(.+?)\]/gi;
      const learned = [];
      let cleanResultText = result.text || '';
      let learnedMatch;
      while ((learnedMatch = learnedRe.exec(cleanResultText)) !== null) {
        learned.push(learnedMatch[1].trim());
      }
      cleanResultText = cleanResultText.replace(learnedRe, '').trim();
      // Use cleanResultText instead of result.text for all subsequent operations
      result.text = cleanResultText;

      // Store learned facts and notify
      for (const fact of learned) {
        try {
          addPreference(msg.senderId, fact, 'conversation');
          await signalAdapter.sendMessage(msg.chatId, `\u{1F4DD} I noted: ${fact}. Say \`!forget ${fact}\` to remove.`);
        } catch (e) {
          console.warn(`[auto-learn] failed to store preference: ${e.message}`);
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
      }

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
        if (!result.streamed) {
          await signalAdapter.sendLongMessage(msg.chatId, result.text || '*(No output)*');
        }
        // F8: extract image attachments from result text regardless of streaming
        // state, and send each as a separate Signal message with the file attached.
        const imagePaths = extractImageAttachments(result.text || '');
        if (imagePaths && imagePaths.size > 0) {
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
      console.error(`[signal] Error: ${err.message}`);
      await signalAdapter.sendMessage(msg.chatId, `Error: ${err.message.substring(0, 500)}`);
      sendErrorAlert(err, { source: 'signal handler', channel: chatId });
    } finally {
      clearInterval(signalTypingInterval);
      state.busy = false;
      state.startedAt = null;
      state.progress = freshProgress();
      state.activeTask = null;
      saveChannelState(chatId, state, { critical: true });
      // Drain queue
      if (state.queue.length > 0) {
        await processQueue(state);
        // processQueue clears in-memory state; re-persist so disk matches.
        saveChannelState(chatId, state, { critical: true });
      }
    }
  });

  signalAdapter.start().catch(err => {
    console.error(`[signal] Failed to start: ${err.message}`);
  });
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
    client, // for commands that need client.channels
    _signalSenderId: msg.senderId, // used by wizards/onComplete to key profile saves
    _signalChatId: msg.chatId,
    _signalMentions: msg.mentions || [], // for !onboard target resolution
    _signalBotPhone: signalAdapter?.phoneNumber || null,
  };
}

function start() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('DISCORD_BOT_TOKEN not set — Discord bot disabled');
  } else {
    client.login(token);
  }

  // Start Signal adapter if configured
  startSignalAdapter();
}

module.exports = { start, askClaude, runClaudeWithContinuation, client, getChannelState, getPersonalityFile, sendLongMessage, freshProgress, channels, signalAdapter, discordAdapter, _tryUnlock, _isChannelElevated };
