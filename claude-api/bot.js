const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const { spawn, execSync } = require('child_process');
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

const PERSONALITIES_DIR = path.join(__dirname, 'personalities');
const DEFAULT_PERSONALITY = 'tiffany_pollard';
const DEFAULT_WORKSPACE = '/workspace';
const DEFAULT_MAX_TURNS = 50;       // Let Claude work autonomously for many turns
const MAX_AUTO_CONTINUES = 3;       // Auto-continue up to 3 times on turn limit
const MAX_TIMEOUT = 90 * 60 * 1000; // 90 minutes hard cap
const STALL_THRESHOLDS = {
  thinking: 5 * 60 * 1000,   // 5 min — no tool active, just "thinking"
  browser:  15 * 60 * 1000,  // 15 min — MCP/Playwright tools
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
  mcp__playwright_browser_navigate: 'Browsing',
  mcp__playwright_browser_screenshot: 'Taking screenshot',
  mcp__playwright_browser_click: 'Clicking',
  mcp__playwright_browser_type: 'Typing',
  mcp__playwright_browser_search: 'Searching',
};

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
  return {
    currentTool: null, toolDetail: '', toolHistory: [], turnCount: 0,
    lastActivity: Date.now(), recentOutputs: [],
    rawLog: [],           // rolling buffer of last 30 terminal-style log lines
    stallWarned: false,   // track whether we've sent a stall warning
    toolSignatures: [],   // for loop detection — last 15 tool signatures
    lastLoopWarning: 0,   // cooldown timestamp for loop warnings
    activeAgents: new Map(),  // tool_use_id → { description, startedAt, lastTool, lastDetail }
    completedAgents: [],      // [{ description, completedAt }]
  };
}

function getStallThreshold(currentTool) {
  if (!currentTool) return STALL_THRESHOLDS.thinking;
  if (currentTool.startsWith('mcp__playwright')) return STALL_THRESHOLDS.browser;
  if (currentTool === 'Bash') return STALL_THRESHOLDS.bash;
  return STALL_THRESHOLDS.default;
}

function pushRawLog(progress, entry) {
  const elapsed = Math.round((Date.now() - (progress._startTime || Date.now())) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  progress.rawLog.push({ ts, text: entry });
  if (progress.rawLog.length > 50) progress.rawLog.shift();
}

function detectLoop(progress) {
  const sigs = progress.toolSignatures;
  if (sigs.length < 8) return false;
  // Same signature 5+ times in last 10 — very likely a real loop
  const last10 = sigs.slice(-10);
  const counts = {};
  for (const s of last10) { counts[s] = (counts[s] || 0) + 1; }
  for (const c of Object.values(counts)) { if (c >= 5) return true; }
  // A-B-A-B-A-B pattern — 3 full repetitions in last 6
  const last6 = sigs.slice(-6);
  if (last6.length === 6
    && last6[0] === last6[2] && last6[2] === last6[4]
    && last6[1] === last6[3] && last6[3] === last6[5]
    && last6[0] !== last6[1]) return true;
  return false;
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

// Graceful shutdown — persist active task state so we can resume after restart
function gracefulShutdown(signal) {
  console.log(`[shutdown] Received ${signal}, persisting state...`);
  for (const [channelId, state] of channels) {
    if (state.busy && state.activeTask) {
      saveChannelState(channelId, state);
    }
  }
  flushPendingWrites();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

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

function askClaude(prompt, { sessionId = null, personalityFile = null, identity = null, cwd = DEFAULT_WORKSPACE, maxTurns = DEFAULT_MAX_TURNS, channelState = null, discordChannel = null } = {}) {
  return new Promise((resolve, reject) => {
    // Auto-load project context on new sessions (CLAUDE.md + NextSteps.md + session journal)
    if (!sessionId) {
      const contextParts = [];

      // Load CLAUDE.md for project conventions
      const claudeMdPath = path.join(cwd, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) {
        try {
          let claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
          if (claudeMd.trim()) {
            if (claudeMd.length > 6000) claudeMd = claudeMd.substring(0, 6000) + '\n...(truncated)';
            contextParts.push(`[Project CLAUDE.md — conventions, stack, how to build/test]:\n${claudeMd}`);
          }
        } catch {}
      }

      // Load NextSteps.md for session handoff
      const nextStepsPath = path.join(cwd, 'NextSteps.md');
      if (fs.existsSync(nextStepsPath)) {
        try {
          let nextSteps = fs.readFileSync(nextStepsPath, 'utf-8');
          if (nextSteps.trim()) {
            if (nextSteps.length > 4000) nextSteps = nextSteps.substring(0, 4000) + '\n...(truncated)';
            contextParts.push(`[Context from previous session — NextSteps.md]:\n${nextSteps}`);
          }
        } catch {}
      }

      // Load rolling session journal (last 3 sessions across restarts)
      if (channelState?._channelId) {
        const journalContext = getJournalContext(channelState._channelId);
        if (journalContext) contextParts.push(journalContext);
      }

      if (contextParts.length > 0) {
        prompt = contextParts.join('\n\n') + `\n\n[Current request]:\n${prompt}`;
      }
    }

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', 'sonnet',
      '--max-turns', String(maxTurns),
      '--dangerously-skip-permissions',
      '--mcp-config', '/home/node/.claude/.mcp.json',
    ];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // Combine identity + personality into a single system prompt
    // (Claude CLI only allows one of --append-system-prompt or --append-system-prompt-file)
    const systemParts = [];
    systemParts.push(`CRITICAL RULE — BREVITY: This is Discord, NOT an essay. Your #1 priority is being SHORT.
- MAX 2-4 sentences for simple questions. MAX 6-8 sentences for complex ones.
- NO long intros, NO dramatic buildups, NO monologues, NO sign-offs unless asked.
- Get to the answer IMMEDIATELY. Personality flavor is 10-20% of the message, not 80%.
- If you catch yourself writing more than 5 lines, CUT IT IN HALF.
- Bullet points over paragraphs. Always.

CRITICAL RULE — IMAGE ATTACHMENTS: Whenever you generate, save, or display any image files, you MUST include their full absolute file paths in your text response (e.g. /workspace/BookFactory/output/book_id/page_01.png). This is required so the Discord bot can attach the images to the message. List every image path on its own line. Do NOT rely on tool output alone — the path must appear in your final text response.

CRITICAL — SUB-AGENTS: You MUST use the Agent tool for any task with 2+ independent parts.
Launch agents IN PARALLEL in a single message. Examples:
- "Fix the API and update tests" → 1 agent for API fix, 1 agent for tests
- "Research X and build Y" → 1 agent for research, 1 agent for building
- "Create 3 endpoints" → 1 agent per endpoint
Do NOT do sequential work when agents can run simultaneously. Think like a manager with a team.
If you're about to do step 1 then step 2, STOP — can they run in parallel? If yes, use agents.

YOUR CAPABILITIES — You are a powerful AI assistant with the following tools. USE THEM. Never say "I can't do that" if one of these covers it:

1. **IMAGE GENERATION**: You CAN generate images! Run: curl -s -X POST http://localhost:3400/imagine -H "Content-Type: application/json" -d '{"prompt":"your detailed description here"}' — returns a file path. Include that path in your response so Discord attaches it. Use this when asked to draw, generate, create, or send any image/picture/photo/artwork.

2. **WEB BROWSING / GOOGLE**: You have a headless Chromium browser via Playwright MCP tools. You can navigate to websites, take screenshots, click elements, fill forms, and extract content. When asked to look something up, google something, check a website, or find information online — USE THE BROWSER. You can also use WebSearch and WebFetch tools.

3. **CODE & FILE OPERATIONS**: You can read, write, edit, and create any files. You can run any shell command. You can search codebases with Grep/Glob. You ARE a full software engineer — you build features, fix bugs, refactor code, write tests.

4. **DOCKER ACCESS**: You can run \`docker ps\`, \`docker restart\`, \`docker compose up -d --build\`, etc. When you make code changes that need a rebuild, just do it yourself — don't tell the user to do it. The project docker-compose.yml is at /workspace/MyBot/docker-compose.yml.

**SELF-REBUILD SAFETY** (MUST follow when rebuilding THIS bot's container):
1. Syntax-check FIRST: \`for f in /workspace/MyBot/claude-api/*.js; do node -c "$f"; done\`
2. Fix ANY syntax errors before proceeding
3. Then rebuild: \`docker compose -f /workspace/MyBot/docker-compose.yml up -d --build\`
The bot has automatic crash-loop recovery — if new code crashes 3x in 2 min, it auto-rollbacks to the last working version and notifies the error channel.

DEPLOYMENT VERIFICATION: After ANY \`docker compose up -d --build\` or \`docker restart\`:
1. Wait 10s, then \`docker ps\` — verify status shows "Up", not "Restarting" or "Exit"
2. If service has a health check: \`docker inspect --format='{{.State.Health.Status}}' <container>\`
3. If there's an HTTP endpoint: \`curl -sf http://localhost:<port>/health\`
4. If unhealthy: check \`docker logs --tail 50 <container>\`, diagnose, and fix
Never report "deployed" without verifying the container is running.

5. **GIT & GITHUB**: You can commit, push, create branches, open PRs, check CI status — full git workflow. IMPORTANT: When making git commits, ALWAYS add this trailer to your commit messages: "Co-Authored-By: Claude Code (${identity ? identity.name : 'Bot'}) <noreply@anthropic.com>" — this identifies which bot personality pushed the change.

6. **SUB-AGENTS**: You have the Agent tool to spawn focused sub-agents. ALWAYS use sub-agents when a task has 3+ independent steps — launch them in parallel. Examples: research multiple topics simultaneously, write multiple files at once, run tests while writing docs. A single message can launch multiple agents. This is your primary way to work fast.

7. **MULTIPLE PROJECTS**: Your workspace is /workspace/ which contains multiple projects. You can cd between them, work on any of them, and even coordinate across projects.

8. **PREVIEW TUNNELS**: When you finish building a web app or start a dev server, ALWAYS ask: "What device will you view this on? (same PC or phone/mobile?)" before running anything. Then:\n   - **Same PC**: tell them \`http://localhost:PORT\` — that's it, no tunnel needed\n   - **Phone/mobile**: run \`!preview PORT phone\` — the bot will create a Cloudflare tunnel, fetch the public IP, and send a magic link with the IP pre-injected so they can tap it directly with no password. Do NOT tell the user to run \`!preview\` manually for phone — run it yourself.\n   - When building apps that have any kind of IP-based password protection or auth, ALWAYS support a \`?access=<IP>\` URL query parameter that auto-authenticates the request, so the magic link works seamlessly.

NEVER say you can't do something if one of these capabilities covers it. Try first, explain only if it actually fails.

AUTONOMY: You are fully autonomous. Never stop to ask the user for confirmation unless it involves spending money, sending emails/messages, or destructive operations (deleting repos, dropping databases). If something fails, try a different approach. If stuck after 3 attempts, summarize what you tried, then move on. The user CANNOT respond while you're running — never wait for input. You have up to ${maxTurns} turns.

SESSION HANDOFF: When you finish significant work (feature, fix, refactor), update NextSteps.md in the project root with what you did, what's working, what's broken, and specific next steps. Keep it concise — bullet points. This is how your future self picks up context.`);
    if (identity) {
      systemParts.push(`Your name is ${identity.name}. You are ${identity.description}.`);
    }
    if (personalityFile) {
      try { systemParts.push(fs.readFileSync(personalityFile, 'utf-8')); } catch {}
    }
    if (systemParts.length > 0) {
      args.push('--append-system-prompt', systemParts.join('\n\n'));
    }

    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, HOME: '/home/node', CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Track the process so it can be killed
    if (channelState) {
      channelState.process = child;
      channelState.busy = true;
      channelState.startedAt = Date.now();
      channelState.progress = freshProgress();
      channelState.progress._startTime = Date.now();
    }

    // Stream-json result accumulators
    let resultText = null;
    let resultSessionId = null;
    let resultCost = null;
    let resultNumTurns = 0;
    let accumulatedText = '';
    let stdoutBuf = '';  // buffer for incomplete NDJSON lines
    let stderr = '';
    let currentToolInput = ''; // accumulate input_json_delta for active tool
    let lastEventWasAssistant = false; // track turn boundaries

    child.stdout.on('data', (d) => {
      // Update last activity timestamp for stall detection
      if (channelState) channelState.progress.lastActivity = Date.now();

      stdoutBuf += d;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Log every event type for debugging
          console.log(`[event] type=${event.type}${event.subtype ? ` subtype=${event.subtype}` : ''}${event.message?.role ? ` role=${event.message.role}` : ''}${event.parent_tool_use_id ? ` parent=${event.parent_tool_use_id}` : ''}`);

          // Detect sub-agent context from parent_tool_use_id
          const parentId = event.parent_tool_use_id || null;
          const agentObj = parentId && channelState ? channelState.progress.activeAgents.get(parentId) : null;
          const agentLabel = agentObj ? agentObj.description : null;
          // Update agent's last tool if this is a tool_use event inside an agent
          if (agentObj && event.type === 'assistant' && event.message?.content?.[0]?.type === 'tool_use') {
            agentObj.lastTool = event.message.content[0].name;
            agentObj.lastDetail = summarizeToolInput(event.message.content[0].name, JSON.stringify(event.message.content[0].input || {}));
          }

          // Final result event from Claude CLI
          if (event.type === 'result') {
            resultText = event.result || '';
            resultSessionId = event.session_id || resultSessionId;
            resultCost = event.total_cost_usd || resultCost;
            resultNumTurns = event.num_turns || resultNumTurns;
            console.log(`[result] turns=${resultNumTurns} cost=$${resultCost} text_len=${(resultText || '').length}`);
            continue;
          }

          // Track session ID from any event
          if (event.session_id) resultSessionId = event.session_id;

          // Non-assistant events — capture tool results, mark turn boundary
          if (event.type !== 'assistant') {
            lastEventWasAssistant = false;
            // Capture tool result summaries for !btw display
            if (channelState && event.message?.content) {
              for (const rb of event.message.content) {
                if (rb.type === 'tool_result') {
                  console.log(`[tool-result] id=${rb.tool_use_id || '?'} is_error=${!!rb.is_error} content_type=${typeof rb.content}`);
                  // Check if this result completes a sub-agent
                  if (rb.tool_use_id && channelState.progress.activeAgents.has(rb.tool_use_id)) {
                    const agentInfo = channelState.progress.activeAgents.get(rb.tool_use_id);
                    channelState.progress.activeAgents.delete(rb.tool_use_id);
                    channelState.progress.completedAgents.push({
                      description: agentInfo.description,
                      type: agentInfo.type,
                      completedAt: Date.now(),
                    });
                    pushRawLog(channelState.progress, `🤖 Agent done: ${agentInfo.description}`);
                  }
                  // Extract text from tool result content
                  let resultText = '';
                  if (typeof rb.content === 'string') {
                    resultText = rb.content;
                  } else if (Array.isArray(rb.content)) {
                    resultText = rb.content
                      .filter(c => c.type === 'text')
                      .map(c => c.text)
                      .join(' ');
                  }
                  if (resultText) {
                    // Strip system/internal noise from preview
                    const cleaned = resultText
                      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
                      .replace(/<tool_use_error>[\s\S]*?<\/tool_use_error>/g, '(cancelled)')
                      .replace(/<persisted-output>/g, '')
                      .replace(/^File content \(\d+ tokens\) exceeds.*$/m, '(file too large — retrying with offset)')
                      .trim();
                    if (cleaned) {
                      const firstLine = cleaned.split('\n').find(l => l.trim().length > 3 && !l.startsWith('<')) || cleaned.substring(0, 120);
                      const preview = firstLine.length > 120 ? firstLine.substring(0, 117) + '...' : firstLine;
                      const prefix = agentLabel ? `  ↳ [${agentLabel}] ` : '  ';
                      pushRawLog(channelState.progress, `${prefix}← ${preview}`);
                    }
                  } else if (rb.is_error) {
                    const prefix = agentLabel ? `  ↳ [${agentLabel}] ` : '  ';
                    pushRawLog(channelState.progress, `${prefix}← ❌ Error`);
                  }
                }
              }
            }
            continue;
          }

          // Assistant events — CLI stream-json emits each content block as a separate
          // assistant event with event.message.content[0] containing the full block.
          // There are NO content_block_start/delta/stop events in this format.
          if (!channelState) continue;

          // Count a new turn when we transition from non-assistant to assistant
          if (!lastEventWasAssistant) {
            channelState.progress.turnCount++;
            pushRawLog(channelState.progress, `── Turn ${channelState.progress.turnCount} ──`);
            lastEventWasAssistant = true;
          }

          const content = event.message?.content;
          if (!Array.isArray(content) || content.length === 0) continue;

          const block = content[0];

          if (block.type === 'tool_use') {
            const name = block.name;
            const inputStr = JSON.stringify(block.input || {});
            const detail = summarizeToolInput(name, inputStr);
            console.log(`[tool] ${name} | ${detail || inputStr.substring(0, 100)}`);

            // Track Agent spawns
            if (name === 'Agent') {
              const agentDesc = block.input?.description || 'sub-agent';
              const agentType = block.input?.subagent_type || 'general-purpose';
              channelState.progress.activeAgents.set(block.id, {
                description: agentDesc,
                type: agentType,
                startedAt: Date.now(),
                lastTool: null,
                lastDetail: '',
              });
              pushRawLog(channelState.progress, `🤖 Spawned [${agentType}]: ${agentDesc}`);
            }

            // Log tool start
            channelState.progress.currentTool = name;
            channelState.progress.toolDetail = detail;
            channelState.progress.stallWarned = false;
            const toolPrefix = agentLabel ? `  ↳ [${agentLabel}] ` : '';
            pushRawLog(channelState.progress, `${toolPrefix}⚡ ${name}${detail ? ` (${detail.length > 60 ? detail.substring(0, 57) + '...' : detail})` : ''}`);

            // Log tool as completed (CLI gives us the full block at once)
            channelState.progress.toolHistory.push({ name, detail });
            if (channelState.progress.toolHistory.length > 10) {
              channelState.progress.toolHistory.shift();
            }
            const label = TOOL_LABELS[name] || name;
            pushOutput(channelState.progress, `🔧 ${label}${detail ? `: ${detail}` : ''}`);

            // Loop detection
            const sig = `${name}:${(detail || '').substring(0, 80)}`;
            channelState.progress.toolSignatures.push(sig);
            if (channelState.progress.toolSignatures.length > 15) {
              channelState.progress.toolSignatures.shift();
            }
            if (detectLoop(channelState.progress) && discordChannel) {
              const now = Date.now();
              if (!channelState.progress.lastLoopWarning || now - channelState.progress.lastLoopWarning > 120000) {
                channelState.progress.lastLoopWarning = now;
                discordChannel.send('⚠️ **Loop detected** — Claude appears to be repeating the same actions. Auto-killing in 60s if it continues.').catch(() => {});
                setTimeout(() => {
                  if (channelState.process && detectLoop(channelState.progress)) {
                    child.kill();
                    discordChannel.send('🛑 Killed due to detected loop.').catch(() => {});
                  }
                }, 60000);
              }
            }

            channelState.progress.currentTool = null;
            channelState.progress.toolDetail = '';

          } else if (block.type === 'text' && block.text) {
            accumulatedText += block.text;
            // Flush completed lines for !btw display
            const textLines = accumulatedText.split('\n');
            accumulatedText = textLines.pop(); // keep last partial line
            for (const tl of textLines) {
              const trimmed = tl.trim();
              if (trimmed.length > 5) {
                const txtPrefix = agentLabel ? `  ↳ [${agentLabel}] ` : '';
                pushOutput(channelState.progress, `💬 ${trimmed}`);
                pushRawLog(channelState.progress, `${txtPrefix}💭 ${trimmed}`);
              }
            }

          } else if (block.type === 'thinking') {
            // Track thinking as activity but don't expose content
            const thinkPrefix = agentLabel ? `  ↳ [${agentLabel}] ` : '';
            pushRawLog(channelState.progress, `${thinkPrefix}🧠 Thinking...`);
          }
        } catch (parseErr) {
          // Log unparseable lines instead of silently dropping
          const preview = line.substring(0, 150);
          console.log(`[parse-error] ${parseErr.message} | line: ${preview}`);
        }
      }
    });

    child.stderr.on('data', (d) => {
      stderr += d;
      if (channelState) {
        channelState.progress.lastActivity = Date.now();
        // Show stderr lines in rawLog — this is where errors/diagnostics appear
        const stderrLines = d.toString().split('\n');
        for (const sl of stderrLines) {
          const trimmed = sl.trim();
          if (trimmed && trimmed.length > 3) {
            // Skip noisy/repetitive lines
            if (trimmed.startsWith('Compressing') || trimmed.startsWith('Downloading')) continue;
            const preview = trimmed.length > 120 ? trimmed.substring(0, 117) + '...' : trimmed;
            pushRawLog(channelState.progress, `⚠ ${preview}`);
            console.log(`[stderr] ${preview}`);
          }
        }
      }
    });

    // Hard cap timeout — absolute maximum runtime
    const hardTimeout = setTimeout(() => {
      child.kill();
      if (channelState) {
        channelState.process = null;
        channelState.busy = false;
        channelState.startedAt = null;
        channelState.progress = freshProgress();
      }
      const timeoutErr = new Error(`Claude CLI hit hard timeout after ${MAX_TIMEOUT / 60000} minutes`);
      sendErrorAlert(timeoutErr, { source: 'askClaude hard timeout' });
      reject(timeoutErr);
    }, MAX_TIMEOUT);

    // Stall detector — tiered thresholds based on current tool + warning before kill
    const stallCheck = setInterval(() => {
      if (!channelState) return;
      const p = channelState.progress;
      const idle = Date.now() - p.lastActivity;
      const threshold = getStallThreshold(p.currentTool);

      // At 80% of threshold: send warning (once per stall event)
      if (idle >= threshold * 0.8 && !p.stallWarned && discordChannel) {
        p.stallWarned = true;
        const toolInfo = p.currentTool ? `Tool: ${p.currentTool}` : 'Thinking (no tool active)';
        discordChannel.send(`⚠️ **Stall warning** — no output for ${Math.round(idle / 60000)}min. ${toolInfo}. Will kill in ${Math.round((threshold - idle) / 60000)}min if no activity.`).catch(() => {});
      }

      // At 100%: kill with formatted diagnostic
      if (idle >= threshold) {
        child.kill();
        const lastEntries = p.rawLog.slice(-5).map(e => `[${e.ts}] ${e.text}`).join('\n');

        // Send formatted stall diagnostic to Discord before rejecting
        if (discordChannel) {
          const thresholdLabel = !p.currentTool ? 'thinking'
            : p.currentTool.startsWith('mcp__playwright') ? 'browser'
            : p.currentTool === 'Bash' ? 'bash' : 'default';
          const diagLines = [
            `🛑 **Stalled and killed** after ${Math.round(idle / 60000)}min of silence`,
            `**Tool at death:** ${p.currentTool || 'none (thinking)'}`,
            `**Turns completed:** ${p.turnCount}`,
            `**Threshold:** ${Math.round(threshold / 60000)}min (${thresholdLabel})`,
          ];
          if (p.rawLog.length > 0) {
            diagLines.push('', '**Last activity before stall:**', '```', lastEntries, '```');
          }
          discordChannel.send(diagLines.join('\n')).catch(() => {});
        }

        channelState.process = null;
        channelState.busy = false;
        channelState.startedAt = null;
        channelState.progress = freshProgress();
        const stallErr = new Error(`Claude CLI stalled — no output for ${Math.round(idle / 60000)}min (threshold: ${Math.round(threshold / 60000)}min, tool: ${p.currentTool || 'none'}, turns: ${p.turnCount})`);
        sendErrorAlert(stallErr, { source: 'askClaude stall detector' });
        reject(stallErr);
      }
    }, 30000); // check every 30 seconds

    // Periodic check-in — send progress to Discord every CHECKIN_INTERVAL
    let lastCheckin = Date.now();
    const checkinTimer = setInterval(() => {
      if (!discordChannel || !channelState || !channelState.startedAt) return;
      const now = Date.now();
      if (now - lastCheckin < CHECKIN_INTERVAL) return;
      lastCheckin = now;

      const elapsed = Math.round((now - channelState.startedAt) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const p = channelState.progress;
      const parts = [`⏱️ **${mins}m ${secs}s** elapsed`];
      if (p.turnCount > 0) parts.push(`${p.turnCount} turns`);
      if (p.currentTool) {
        const label = TOOL_LABELS[p.currentTool] || p.currentTool;
        parts.push(`Currently: ${label}${p.toolDetail ? ` (${p.toolDetail})` : ''}`);
      }
      discordChannel.send(`*Still working — ${parts.join(' · ')}*`).catch(() => {});
    }, 30000); // evaluate every 30s, only send at CHECKIN_INTERVAL

    child.on('close', (code) => {
      clearTimeout(hardTimeout);
      clearInterval(stallCheck);
      clearInterval(checkinTimer);
      const turnCount = channelState?.progress?.turnCount || 0;
      const elapsed = channelState?.startedAt ? Math.round((Date.now() - channelState.startedAt) / 1000) : 0;
      console.log(`[close] code=${code} turns=${turnCount} elapsed=${elapsed}s stderr_len=${stderr.length}`);
      if (channelState) {
        channelState.process = null;
        channelState.busy = false;
        channelState.startedAt = null;
        channelState.progress = freshProgress();
      }

      // code 143 = killed by !stop, not an error
      if (code === 143 || code === null) {
        return resolve({ text: '*(Process stopped)*', sessionId: channelState?.sessionId, cost: null, stopped: true });
      }

      if (code !== 0) {
        console.error(`[exit-error] code=${code} stderr:`, stderr.substring(0, 1000));
        const exitErr = new Error(`Claude CLI exited with code ${code}\n${stderr.substring(0, 300)}`);
        sendErrorAlert(exitErr, { source: 'askClaude', detail: `Exit code ${code}` });
        return reject(exitErr);
      }

      resolve({
        text: resultText || accumulatedText || '',
        sessionId: resultSessionId,
        cost: resultCost,
        numTurns: resultNumTurns,
        hitTurnLimit: resultNumTurns >= maxTurns,
        stopped: false,
      });
    });
  });
}

async function runClaudeWithContinuation(prompt, opts, discordChannel) {
  let result = await askClaude(prompt, opts);
  let continueCount = 0;
  let totalCost = result.cost || 0;
  let totalTurns = result.numTurns || 0;

  while (result.hitTurnLimit && continueCount < MAX_AUTO_CONTINUES && !result.stopped) {
    continueCount++;
    await discordChannel.send(
      `*Turn limit reached (${continueCount}/${MAX_AUTO_CONTINUES}) — auto-continuing...*`
    ).catch(() => {});
    result = await askClaude(
      'You hit the turn limit. Continue where you left off. If the task is complete, just summarize what you did.',
      { ...opts, sessionId: result.sessionId }
    );
    totalCost += result.cost || 0;
    totalTurns += result.numTurns || 0;
  }

  if (result.hitTurnLimit && continueCount >= MAX_AUTO_CONTINUES) {
    await discordChannel.send(
      `*Reached max auto-continuations (${MAX_AUTO_CONTINUES}). Send another message to keep going.*`
    ).catch(() => {});
  }

  return { ...result, cost: totalCost, numTurns: totalTurns };
}

function extractImageAttachments(text) {
  // Match absolute or relative file paths ending in image extensions
  const imageRegex = /(?:^|\s|["'`(])((\/[^\s"'`()]+|[^\s"'`()]+)\.(?:png|jpg|jpeg|gif|webp))/gim;
  const found = new Set();
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    const p = match[1].trim();
    if (fs.existsSync(p)) found.add(p);
  }
  return [...found].slice(0, 10); // Discord max 10 attachments
}

async function sendLongMessage(message, text, cwd = DEFAULT_WORKSPACE) {
  if (!text || text.length === 0) {
    await message.reply('*(No output)*');
    return;
  }

  // Resolve relative paths against cwd before scanning
  const resolvedText = text.replace(/(?:^|\s)([\w./][^\s"'`()]*\.(?:png|jpg|jpeg|gif|webp))/gim, (m, p) => {
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    return m.replace(p, abs);
  });

  const imagePaths = extractImageAttachments(resolvedText);
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
  await message.reply({ content: chunks[0], files: files.length ? files : undefined }).catch(e => console.error('Reply failed:', e.message));

  for (let i = 1; i < chunks.length && i < 8; i++) {
    await message.channel.send(chunks[i]).catch(e => console.error('Chunk send failed:', e.message));
  }
  if (chunks.length > 8) {
    await message.channel.send(`*(${chunks.length - 8} more chunks truncated)*`);
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

async function handleCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();
  const state = getChannel(message.channel.id);

  switch (cmd) {
    case '!stop': {
      if (state.process) {
        state._userStopped = true; // flag so silent-stop check knows user did this
        state.process.kill();
        state.process = null;
        state.busy = false;
        const dropped = state.queue.length;
        state.queue = [];
        const extra = dropped ? ` (${dropped} queued message${dropped > 1 ? 's' : ''} cleared)` : '';
        await message.reply(`Stopped. Session preserved — send another message to continue where it left off.${extra}`);
      } else {
        await message.reply('Nothing is running in this channel.');
      }
      break;
    }

    case '!clear': {
      if (state.busy) {
        await message.reply('Claude is currently working. Use `!stop` first, then `!clear`.');
        break;
      }
      state.sessionId = null;
      state.queue = [];
      saveChannelState(message.channel.id, state);
      await message.reply('Context cleared. Next message starts a fresh conversation (no memory of previous messages).');
      break;
    }

    case '!kill': {
      if (state.process) {
        state.process.kill();
        state.process = null;
        state.busy = false;
      }
      state.sessionId = null;
      state.queue = [];
      saveChannelState(message.channel.id, state);
      await message.reply('Process killed and session destroyed. Full reset — starting from scratch.');
      break;
    }

    case '!cd': {
      if (!arg) {
        await message.reply(`Current working directory: \`${state.cwd}\``);
      } else {
        const target = arg.startsWith('/') ? arg : path.join(state.cwd, arg);
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          state.cwd = target;
          state.sessionId = null;
          saveChannelState(message.channel.id, state);
          await message.reply(`Working directory: \`${target}\`\nSession cleared for new project context.`);
        } else {
          await message.reply(`Directory not found: \`${target}\`\nAvailable in /workspace:\n${listWorkspaceDirs()}`);
        }
      }
      break;
    }

    case '!ls': {
      const target = arg ? (arg.startsWith('/') ? arg : path.join(state.cwd, arg)) : state.cwd;
      try {
        const entries = fs.readdirSync(target);
        const formatted = entries.map(e => {
          try {
            const full = path.join(target, e);
            const isDir = fs.statSync(full).isDirectory();
            return isDir ? `📁 ${e}/` : `📄 ${e}`;
          } catch { return `  ${e}`; }
        }).join('\n');
        await message.reply(`\`${target}\`:\n${formatted || '(empty)'}`);
      } catch {
        await message.reply(`Cannot read: \`${target}\``);
      }
      break;
    }

    case '!personality': {
      if (!arg) {
        await message.reply(`Current personality: **${state.personality}**`);
      } else {
        const file = getPersonalityFile(arg);
        if (!file) {
          const available = listPersonalities().join(', ');
          await message.reply(`Personality "${arg}" not found. Available: **${available}**`);
        } else {
          state.personality = arg;
          state.sessionId = null;
          saveChannelState(message.channel.id, state);
          await message.reply(`Personality switched to **${arg}**! Session cleared.`);
        }
      }
      break;
    }

    case '!personalities': {
      const available = listPersonalities();
      const list = available.map(p => p === state.personality ? `**${p}** (active)` : p).join('\n- ');
      await message.reply(`Available personalities:\n- ${list}`);
      break;
    }

    case '!status': {
      const allChannels = [];
      for (const [chId, s] of channels) {
        const ch = client.channels.cache.get(chId);
        const chName = ch ? `#${ch.name}` : chId;
        const status = s.busy ? '🔄 WORKING' : (s.sessionId ? '💤 idle' : '⚫ no session');
        allChannels.push(`${chName}: ${status} | **${s.identity.name}** | ${s.personality} | \`${s.cwd}\`${s.sessionId ? ` | session \`${s.sessionId.substring(0, 8)}...\`` : ''}`);
      }
      await message.reply(
        `**Bot Status:**\n` +
        (allChannels.length ? allChannels.join('\n') : 'No channels active.') +
        `\n\nHard cap: ${MAX_TIMEOUT / 60000}min | Stall: ${STALL_THRESHOLDS.thinking / 60000}-${STALL_THRESHOLDS.browser / 60000}min (tiered) | Check-in: ${CHECKIN_INTERVAL / 60000}min | Max turns: ${DEFAULT_MAX_TURNS}`
      );
      break;
    }

    case '!restart': {
      await message.reply('Restarting... be right back.');
      // Save channel ID so we can notify when we're back
      try { fs.writeFileSync(path.join(__dirname, '.restart-channel'), message.channel.id); } catch {}
      // Mark as clean shutdown so auto-resume doesn't kick in
      try { fs.writeFileSync(path.join('/home/node/.claude', '.clean-shutdown'), Date.now().toString()); } catch {}
      // Clear active tasks — this is intentional, not a crash
      for (const [chId, s] of channels) {
        s.activeTask = null;
        saveChannelState(chId, s);
      }
      // Flush persisted state before shutdown
      flushPendingWrites();
      // Kill all active processes first
      for (const [, s] of channels) {
        if (s.process) s.process.kill();
      }
      // Exit cleanly — Docker restart policy will bring the container back up
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case '!killall': {
      for (const [chId, s] of channels) {
        if (s.process) s.process.kill();
        s.queue = [];
        s.sessionId = null;
        saveChannelState(chId, s);
      }
      flushPendingWrites();
      channels.clear();
      await message.reply('All processes killed and all sessions destroyed across every channel.');
      break;
    }

    case '!imagine': {
      if (!arg) {
        await message.reply('Usage: `!imagine <description>` — e.g. `!imagine a cow in a spacesuit on the moon`');
        break;
      }
      if (!process.env.OPENAI_API_KEY) {
        await message.reply('No OpenAI API key configured.');
        break;
      }
      const imgParams = { model: 'gpt-image-1', prompt: arg, n: 1, size: '1024x1024', quality: 'low' };
      await message.reply(`**Sending to OpenAI:**\n\`\`\`json\n${JSON.stringify(imgParams, null, 2)}\n\`\`\``);
      await message.channel.sendTyping();
      try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await openai.images.generate(imgParams);
        const base64 = response.data[0].b64_json;
        const buffer = Buffer.from(base64, 'base64');
        const attachment = new AttachmentBuilder(buffer, { name: 'imagine.png' });
        await message.channel.send({ files: [attachment] });
      } catch (err) {
        console.error('Image generation error:', err.message);
        await message.reply(`Image generation failed: ${err.message}`);
      }
      break;
    }

    case '!help': {
      const helpText =
        `**Claude Code Bot — Commands:**\n\n` +
        `**Control:**\n` +
        `\`!stop\` — Pause Claude (session preserved)\n` +
        `\`!clear\` — Clear conversation context\n` +
        `\`!kill\` — Hard kill + destroy session\n` +
        `\`!killall\` — Kill everything across all channels\n` +
        `\`!restart\` — Restart bot container\n` +
        `\`!status\` — Show session info\n` +
        `\`!processes\` — Show active Claude processes\n` +
        `\`!btw\` — Peek at progress while working\n` +
        `\`!cancel\` — Cancel an active wizard\n\n` +
        `**Workspace:**\n` +
        `\`!cd [path]\` — Show or change project directory\n` +
        `\`!ls [path]\` — List files\n` +
        `\`!startproject\` — Create a new project with template\n` +
        `\`!audit [focus]\` — Full project audit (design, qa, security, analytics, performance)\n\n` +
        `**Identity:**\n` +
        `\`!name [name]\` — Show or set bot name\n` +
        `\`!identity [Name is desc]\` — Show or set identity\n` +
        `\`!personality <name>\` — Switch personality\n` +
        `\`!personalities\` — List available\n\n` +
        `**Tasks:** \`!tasks\` · \`!done <#>\` · \`!done all\`\n` +
        `**Schedule:** \`!schedule\` · \`!schedules\` · \`!unschedule <#>\` · \`!autoschedule <freq> | <task>\`\n` +
        `**Queue:** \`!queue <task>\` · \`!queued\` · \`!dequeue <#>\`\n` +
        `**Monitors:** \`!monitor ci <repo>\` · \`!monitor health <url>\` · \`!monitors\` · \`!monitor remove/pause/resume/check <#>\`\n` +
        `**Briefing:** \`!briefing\` · \`!weekly\`\n` +
        `**Preview:** \`!preview <port>\` — smart preview (asks device) · \`!preview <port> local\` — localhost link · \`!preview <port> phone\` — tunnel + magic link · \`!preview stop\`\n` +
        `**Other:** \`!email <request>\` · \`!imagine <desc>\`\n\n` +
        `Just type what you want built. Claude runs autonomously — reads, writes, commits, pushes. Use \`!stop\` to interrupt, \`!clear\` to start over.\n\n` +
        `Current: **${state.identity.name}** | ${state.personality} | \`${state.cwd}\` | ${state.busy ? '🔄 WORKING' : (state.sessionId ? '💤 idle' : '⚫ no session')}`;
      await sendLongMessage(message, helpText, state.cwd);
      break;
    }

    case '!name': {
      if (!arg) {
        await message.reply(`My name is **${state.identity.name}**`);
      } else {
        state.identity.name = arg.trim();
        state.sessionId = null;
        saveChannelState(message.channel.id, state);
        await message.reply(`Name changed to **${state.identity.name}**! Session cleared.`);
      }
      break;
    }

    case '!identity': {
      if (!arg) {
        await message.reply(`**${state.identity.name}** — ${state.identity.description}`);
      } else {
        // Parse "Name is description" or just set as description
        const isMatch = arg.match(/^(\S+)\s+is\s+(.+)$/i);
        if (isMatch) {
          state.identity.name = isMatch[1];
          state.identity.description = isMatch[2].trim();
        } else {
          state.identity.description = arg.trim();
        }
        state.sessionId = null;
        saveChannelState(message.channel.id, state);
        await message.reply(`Identity updated: **${state.identity.name}** — ${state.identity.description}\nSession cleared.`);
      }
      break;
    }

    case '!briefing': {
      const briefings = require('./briefings');
      await message.reply('Running briefing now...');
      briefings.sendBriefing(client).catch(err => {
        message.reply(`Briefing failed: ${err.message}`).catch(() => {});
      });
      break;
    }

    case '!weekly': {
      const briefings = require('./briefings');
      await message.reply('Running weekly preview now...');
      briefings.sendWeeklyPreview(client).catch(err => {
        message.reply(`Weekly preview failed: ${err.message}`).catch(() => {});
      });
      break;
    }

    case '!email': {
      if (!arg) {
        await message.reply('Usage: `!email <who and what>` — e.g. `!email my manager about needing Friday off`');
        break;
      }
      // Don't treat this as a command — fall through to Claude with email-drafting instructions
      const emailPrompt = `Draft 3 email options for the following request. Each option should be a different tone/approach (e.g. direct, warm, formal). For each option:\n- Subject line\n- Body\n\nKeep them professional, clear, and concise. No fluff.\n\nRequest: ${arg}`;
      // Send to Claude like a normal message
      const emailState = getChannel(message.channel.id);
      if (emailState.busy) {
        await message.reply('Claude is still working. Use `!stop` first.');
        break;
      }
      const personalityFile = getPersonalityFile(emailState.personality);
      await message.channel.sendTyping();
      const typingInterval = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
      try {
        const result = await askClaude(emailPrompt, {
          sessionId: emailState.sessionId,
          personalityFile,
          identity: emailState.identity,
          cwd: emailState.cwd,
          channelState: emailState,
          discordChannel: message.channel,
        });
        if (result.sessionId) emailState.sessionId = result.sessionId;
        if (!result.stopped) await sendLongMessage(message, result.text, emailState.cwd);
      } catch (err) {
        const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
        await message.reply(`Error: ${errorMsg}`).catch(() => {});
        sendErrorAlert(err, { source: 'email command', channel: message.channel.id });
      } finally {
        clearInterval(typingInterval);
      }
      break;
    }

    case '!btw': {
      if (!state.busy && !state.process) {
        await message.reply('Nothing running right now.');
        break;
      }
      const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const runtime = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      const p = state.progress;
      const costStr = p._lastCost ? ` | $${p._lastCost.toFixed(4)}` : '';
      const lines = [`**Running ${runtime} | Turn ${p.turnCount || 1}/${DEFAULT_MAX_TURNS}${costStr}**`];

      // Current main thread activity
      if (p.currentTool) {
        const label = TOOL_LABELS[p.currentTool] || p.currentTool;
        lines.push(`📋 **Main:** ${label}${p.toolDetail ? ` — \`${p.toolDetail}\`` : ''}`);
      } else {
        lines.push(`📋 **Main:** Thinking...`);
      }

      // Agents section — active + completed
      const activeCount = p.activeAgents.size;
      const doneCount = p.completedAgents.length;
      if (activeCount > 0 || doneCount > 0) {
        lines.push('');
        lines.push(`🤖 **Agents (${activeCount} active, ${doneCount} done):**`);
        for (const [, agent] of p.activeAgents) {
          const agentElapsed = Math.round((Date.now() - agent.startedAt) / 1000);
          const toolInfo = agent.lastTool ? `${TOOL_LABELS[agent.lastTool] || agent.lastTool}` : 'Starting...';
          const typeTag = agent.type && agent.type !== 'general-purpose' ? `\`${agent.type}\` ` : '';
          lines.push(`  🟢 ${typeTag}"${agent.description}" — ${toolInfo} (${agentElapsed}s)`);
        }
        for (const agent of p.completedAgents.slice(-5)) {
          const typeTag = agent.type && agent.type !== 'general-purpose' ? `\`${agent.type}\` ` : '';
          lines.push(`  ✅ ${typeTag}"${agent.description}" — Done`);
        }
      }

      // Recent activity log — last 10 entries
      if (p.rawLog.length > 0) {
        lines.push('');
        lines.push(`📜 **Recent (last 10):**`);
        const visible = p.rawLog.slice(-10);
        lines.push('```');
        for (const entry of visible) {
          lines.push(`[${entry.ts}] ${entry.text}`);
        }
        lines.push('```');
      }

      await sendLongMessage(message, lines.join('\n'), state.cwd);
      break;
    }

    case '!tasks': {
      const { loadActiveTasks, formatTaskList } = require('./tasks-storage');
      const active = loadActiveTasks();
      if (active.length === 0) {
        await message.reply('No active tasks. Add some via the evening check-in or they\'ll show up after you chat with me about your plans!');
      } else {
        await message.reply(`**Active Tasks:**\n${formatTaskList(active)}\n\nUse \`!done <#>\` to mark done, \`!done all\` to clear all.`);
      }
      break;
    }

    case '!done': {
      const { markDone } = require('./tasks-storage');
      const result = markDone(arg || '');
      await message.reply(result);
      break;
    }

    case '!cancel': {
      await cancelWizard(state, message);
      break;
    }

    case '!processes': {
      try {
        const output = execSync(
          'ps aux --sort=-%mem | head -1; ps aux --sort=-%mem | grep "[c]laude" || echo "No Claude processes running"',
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();

        const activeChannels = [];
        for (const [chId, s] of channels) {
          if (s.busy && s.process) {
            const ch = client.channels.cache.get(chId);
            const chName = ch ? `#${ch.name}` : chId;
            activeChannels.push(`${chName}: PID ${s.process.pid}`);
          }
        }

        const channelInfo = activeChannels.length
          ? `\n\n**Active bot tasks:**\n${activeChannels.join('\n')}`
          : '\n\n**No active bot tasks**';

        await message.reply(`**System Processes:**\n\`\`\`\n${output}\n\`\`\`${channelInfo}`);
      } catch (err) {
        await message.reply(`Error checking processes: ${err.message}`);
      }
      break;
    }

    case '!preview': {
      // !preview <port> — ask what device, then either show localhost or start tunnel
      // !preview <port> local — show localhost link (same PC)
      // !preview <port> phone|tunnel|mobile — create Cloudflare tunnel + magic link
      // !preview stop — stop the active tunnel
      // !preview — show current tunnel status

      if (arg === 'stop') {
        if (state._tunnel) {
          state._tunnel.kill();
          state._tunnel = null;
          state._tunnelPort = null;
          state._tunnelUrl = null;
          state._pendingPreview = null;
          await message.reply('Tunnel stopped.');
        } else {
          await message.reply('No tunnel is running.');
        }
        break;
      }

      // Parse args — could be "3000", "3000 local", "3000 phone"
      const previewParts = arg ? arg.trim().split(/\s+/) : [];
      const previewPort = parseInt(previewParts[0], 10);
      const previewMode = previewParts[1] ? previewParts[1].toLowerCase() : null;

      if (!arg || isNaN(previewPort)) {
        if (state._tunnelUrl) {
          await message.reply(`**Active tunnel:** ${state._tunnelUrl} → localhost:${state._tunnelPort}\nUse \`!preview stop\` to close it.`);
        } else {
          await message.reply('No tunnel running. Usage: `!preview <port>` — e.g. `!preview 3000`');
        }
        break;
      }

      if (previewPort < 1 || previewPort > 65535) {
        await message.reply('Provide a valid port number. Usage: `!preview 3000`');
        break;
      }

      // If no mode specified, ask what device they're on
      if (!previewMode) {
        state._pendingPreview = previewPort;
        await message.reply(
          `What device are you viewing on?\n` +
          `• Reply \`local\` — same PC (I'll give you a localhost link)\n` +
          `• Reply \`phone\` — mobile/tablet (I'll create a tunnel + magic link)`
        );
        break;
      }

      // Handle local mode
      if (previewMode === 'local') {
        state._pendingPreview = null;
        await message.reply(`**Open on this PC:** http://localhost:${previewPort}`);
        break;
      }

      // Handle phone/tunnel/mobile mode — create Cloudflare tunnel + magic link
      if (['phone', 'tunnel', 'mobile', 'remote'].includes(previewMode)) {
        state._pendingPreview = null;

        // Kill existing tunnel if any
        if (state._tunnel) {
          state._tunnel.kill();
          state._tunnel = null;
        }

        await message.reply(`Creating tunnel to localhost:${previewPort}...`);

        // Fetch public IP for the magic link bypass
        let publicIp = null;
        try {
          const { execSync } = require('child_process');
          publicIp = execSync('curl -sf --max-time 5 https://api.ipify.org', { encoding: 'utf8' }).trim();
        } catch {}

        const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${previewPort}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let urlFound = false;
        const onData = (data) => {
          const text = data.toString();
          const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (urlMatch && !urlFound) {
            urlFound = true;
            state._tunnelUrl = urlMatch[0];
            state._tunnelPort = previewPort;
            const baseUrl = urlMatch[0];
            const magicUrl = publicIp ? `${baseUrl}?access=${publicIp}` : baseUrl;
            const ipNote = publicIp ? `\nYour public IP \`${publicIp}\` is pre-injected — just tap the link, no password needed.` : '';
            message.channel.send(
              `**Tunnel live! Tap this on your phone:**\n${magicUrl}${ipNote}\n\nUse \`!preview stop\` to close.`
            ).catch(() => {});
          }
        };

        tunnel.stdout.on('data', onData);
        tunnel.stderr.on('data', onData);

        tunnel.on('close', () => {
          if (state._tunnel === tunnel) {
            state._tunnel = null;
            state._tunnelPort = null;
            state._tunnelUrl = null;
          }
        });

        state._tunnel = tunnel;

        setTimeout(() => {
          if (!urlFound && state._tunnel === tunnel) {
            tunnel.kill();
            state._tunnel = null;
            message.channel.send(`Failed to start tunnel — is anything running on port ${previewPort}?`).catch(() => {});
          }
        }, 15000);
        break;
      }

      await message.reply(`Unknown mode \`${previewMode}\`. Use \`local\` or \`phone\`.`);
      break;
    }

    case '!startproject': {
      if (state.busy) {
        await message.reply('Claude is still working. Use `!stop` first.');
        break;
      }
      if (state.wizard) {
        await message.reply('A wizard is already active. Use `!cancel` to cancel it first.');
        break;
      }
      const { startProjectWizard } = require('./wizards/startproject');
      await startProjectWizard(state, message);
      break;
    }

    case '!schedule': {
      if (state.busy) {
        await message.reply('Claude is still working. Use `!stop` first.');
        break;
      }
      if (state.wizard) {
        await message.reply('A wizard is already active. Use `!cancel` to cancel it first.');
        break;
      }
      await startWizard(state, message, {
        type: 'schedule',
        steps: [
          {
            key: 'message',
            prompt: 'What message should I send you? (e.g. "Time to check your stocks!" or "Drink water and stretch")',
          },
          {
            key: 'frequency',
            prompt: 'How often? Pick one:\n' +
              '• `daily at 9am` — every day at a specific time\n' +
              '• `every 2 hours` — repeating interval\n' +
              '• `weekdays at 8:30am` — Mon-Fri only\n' +
              '• `monday at 10am` — specific day of week\n' +
              '• Or a cron expression like `0 */3 * * *`',
            validate: (input) => {
              const parsed = parseFrequency(input);
              if (!parsed) return 'Could not understand that frequency. Try something like `daily at 9am`, `every 3 hours`, `weekdays at 8:30am`, or a cron expression.';
              return true;
            },
          },
        ],
        onComplete: async (data, msg) => {
          const parsed = parseFrequency(data.frequency);
          const sched = addSchedule({
            userId: msg.author.id,
            channelId: msg.channel.id,
            message: data.message,
            cronRule: parsed.cron,
            description: parsed.description,
            timezone: 'America/Los_Angeles',
          });
          registerJob(sched, client);
          await msg.reply(
            `Scheduled! **#${sched.id}**\n` +
            `📝 "${sched.message}"\n` +
            `⏰ ${parsed.description}\n` +
            `I'll DM you each time. Use \`!schedules\` to see all, \`!unschedule ${sched.id}\` to remove.`
          );
        },
      });
      break;
    }

    case '!schedules': {
      const userSchedules = getUserSchedules(message.author.id);
      if (userSchedules.length === 0) {
        await message.reply('You have no scheduled messages. Use `!schedule` to create one.');
      } else {
        await message.reply(`**Your Schedules:**\n${formatScheduleList(userSchedules)}\n\nUse \`!unschedule <#>\` to remove one.`);
      }
      break;
    }

    case '!unschedule': {
      if (!arg) {
        await message.reply('Usage: `!unschedule <#>` — e.g. `!unschedule 1`');
        break;
      }
      const id = parseInt(arg, 10);
      if (isNaN(id)) {
        await message.reply('Usage: `!unschedule <#>` — provide the schedule number.');
        break;
      }
      const removed = removeSchedule(id, message.author.id);
      if (!removed) {
        await message.reply(`No schedule #${id} found for you. Use \`!schedules\` to see your list.`);
      } else {
        cancelJob(id);
        await message.reply(`Removed schedule **#${id}**: "${removed.description}"`);
      }
      break;
    }

    case '!autoschedule': {
      // Usage: !autoschedule <frequency> | <task prompt>
      if (!arg || !arg.includes('|')) {
        await message.reply('Usage: `!autoschedule <frequency> | <task>`\nExample: `!autoschedule daily at 9am | check all projects for failing tests and fix them`');
        break;
      }
      const [freqPart, ...taskParts] = arg.split('|');
      const freq = freqPart.trim();
      const task = taskParts.join('|').trim();
      if (!freq || !task) {
        await message.reply('Both frequency and task required. Example: `!autoschedule every 2 hours | run the test suite`');
        break;
      }
      const parsed = parseFrequency(freq);
      if (!parsed) {
        await message.reply(`Couldn't parse frequency: "${freq}". Try: daily at 9am, every 2 hours, weekdays at 8:30am`);
        break;
      }
      const autoSched = addSchedule({
        userId: message.author.id,
        channelId: message.channel.id,
        message: task,
        cronRule: parsed.cron,
        description: parsed.description,
        type: 'task',
        cwd: state.cwd,
        timezone: 'America/Los_Angeles',
      });
      registerJob(autoSched, client);
      await message.reply(
        `Autonomous task scheduled! **#${autoSched.id}**\n` +
        `⏰ ${parsed.description}\n` +
        `📋 "${task.substring(0, 100)}"\n` +
        `📁 \`${state.cwd}\`\n` +
        `I'll execute this autonomously each time. Use \`!schedules\` to see all, \`!unschedule ${autoSched.id}\` to remove.`
      );
      break;
    }

    case '!queue': {
      if (!arg) {
        await message.reply('Usage: `!queue <task>` — Add work to the background queue.\nExample: `!queue build a hello world express app`');
        break;
      }
      const { addItem } = require('./queue-storage');
      const item = addItem({
        prompt: arg,
        channelId: message.channel.id,
        userId: message.author.id,
        cwd: state.cwd,
        personality: state.personality,
        identity: { ...state.identity },
      });
      await message.reply(
        `Queued background task **#${item.id}**\n` +
        `📋 "${arg.substring(0, 100)}"\n` +
        `📁 \`${state.cwd}\`\n` +
        `Use \`!queued\` to check status, \`!dequeue ${item.id}\` to remove.`
      );
      break;
    }

    case '!queued': {
      const { getQueue } = require('./queue-storage');
      const queue = getQueue();
      if (queue.length === 0) {
        await message.reply('Background queue is empty. Use `!queue <task>` to add work.');
        break;
      }
      const lines = queue.map(item => {
        const status = item.status === 'running' ? '🔄' : item.status === 'done' ? '✅' : item.status === 'failed' ? '❌' : '⏳';
        const prompt = item.prompt.length > 60 ? item.prompt.substring(0, 57) + '...' : item.prompt;
        return `${status} **#${item.id}** — ${prompt}\n  Status: ${item.status} | \`${item.cwd}\`${item.resultSummary ? `\n  Result: ${item.resultSummary}` : ''}`;
      });
      await sendLongMessage(message, `**Background Queue:**\n${lines.join('\n')}`, state.cwd);
      break;
    }

    case '!dequeue': {
      if (!arg) {
        await message.reply('Usage: `!dequeue <#>` — Remove a pending item from the queue.');
        break;
      }
      const dequeueId = parseInt(arg, 10);
      if (isNaN(dequeueId)) {
        await message.reply('Usage: `!dequeue <#>` — provide the queue item number.');
        break;
      }
      const { removeItem } = require('./queue-storage');
      const removed = removeItem(dequeueId);
      if (!removed) {
        await message.reply(`No pending queue item #${dequeueId} found. Use \`!queued\` to see the list.`);
      } else {
        await message.reply(`Removed queue item **#${dequeueId}**: "${removed.prompt.substring(0, 80)}"`);
      }
      break;
    }

    case '!monitor': {
      const monArgs = parts.slice(1);
      const subCmd = (monArgs[0] || '').toLowerCase();

      if (subCmd === 'ci') {
        // !monitor ci [repo] [--branch=X] [--action=fix|notify] [--interval=N]
        const repo = monArgs[1] || '*';
        const flags = monArgs.slice(2).join(' ');
        const branchMatch = flags.match(/--branch[= ](\S+)/);
        const actionMatch = flags.match(/--action[= ](fix|notify)/);
        const intervalMatch = flags.match(/--interval[= ](\d+)/);
        const mon = addMonitor({
          type: 'github-ci',
          channelId: message.channel.id,
          action: actionMatch ? actionMatch[1] : 'notify',
          config: { repo, branch: branchMatch ? branchMatch[1] : 'main' },
          pollInterval: intervalMatch ? parseInt(intervalMatch[1], 10) : 5,
          cwd: state.cwd,
        });
        const { scheduleMonitor } = require('./monitor-runner');
        scheduleMonitor(mon, client);
        await message.reply(
          `Monitor **#${mon.id}** created!\n` +
          `🔄 **github-ci** — ${repo} (${mon.config.branch})\n` +
          `⚡ Action: ${mon.action} | Every ${mon.pollInterval}min\n` +
          `Use \`!monitors\` to list, \`!monitor remove ${mon.id}\` to delete.`
        );
      } else if (subCmd === 'health') {
        // !monitor health <url> [--action=fix|notify] [--status=200] [--interval=N]
        const url = monArgs[1];
        if (!url) {
          await message.reply('Usage: `!monitor health <url>` — e.g. `!monitor health http://localhost:3400/health`');
          break;
        }
        const flags = monArgs.slice(2).join(' ');
        const actionMatch = flags.match(/--action[= ](fix|notify)/);
        const statusMatch = flags.match(/--status[= ](\d+)/);
        const intervalMatch = flags.match(/--interval[= ](\d+)/);
        const mon = addMonitor({
          type: 'url-health',
          channelId: message.channel.id,
          action: actionMatch ? actionMatch[1] : 'notify',
          config: { url, expectStatus: statusMatch ? parseInt(statusMatch[1], 10) : 200 },
          pollInterval: intervalMatch ? parseInt(intervalMatch[1], 10) : 5,
          cwd: state.cwd,
        });
        const { scheduleMonitor } = require('./monitor-runner');
        scheduleMonitor(mon, client);
        await message.reply(
          `Monitor **#${mon.id}** created!\n` +
          `🔄 **url-health** — ${url}\n` +
          `⚡ Action: ${mon.action} | Every ${mon.pollInterval}min\n` +
          `Use \`!monitors\` to list, \`!monitor remove ${mon.id}\` to delete.`
        );
      } else if (subCmd === 'remove') {
        const id = parseInt(monArgs[1], 10);
        if (isNaN(id)) {
          await message.reply('Usage: `!monitor remove <id>`');
          break;
        }
        const removed = removeMonitor(id);
        if (!removed) {
          await message.reply(`No monitor #${id} found.`);
        } else {
          const { cancelMonitor } = require('./monitor-runner');
          cancelMonitor(id);
          await message.reply(`Removed monitor **#${id}** (${removed.type}).`);
        }
      } else if (subCmd === 'pause') {
        const id = parseInt(monArgs[1], 10);
        if (isNaN(id)) { await message.reply('Usage: `!monitor pause <id>`'); break; }
        const mon = updateMonitor(id, { enabled: false });
        if (!mon) { await message.reply(`No monitor #${id} found.`); break; }
        const { cancelMonitor } = require('./monitor-runner');
        cancelMonitor(id);
        await message.reply(`Paused monitor **#${id}**. Use \`!monitor resume ${id}\` to re-enable.`);
      } else if (subCmd === 'resume') {
        const id = parseInt(monArgs[1], 10);
        if (isNaN(id)) { await message.reply('Usage: `!monitor resume <id>`'); break; }
        const mon = updateMonitor(id, { enabled: true });
        if (!mon) { await message.reply(`No monitor #${id} found.`); break; }
        const { scheduleMonitor } = require('./monitor-runner');
        scheduleMonitor(mon, client);
        await message.reply(`Resumed monitor **#${id}**.`);
      } else if (subCmd === 'check') {
        const id = parseInt(monArgs[1], 10);
        if (isNaN(id)) { await message.reply('Usage: `!monitor check <id>`'); break; }
        const mon = getMonitor(id);
        if (!mon) { await message.reply(`No monitor #${id} found.`); break; }
        await message.reply(`Running immediate check for monitor **#${id}**...`);
        const { runPoll } = require('./monitor-runner');
        runPoll(id, client).catch(err => {
          message.reply(`Check failed: ${err.message}`).catch(() => {});
        });
      } else {
        await message.reply(
          `**Monitor Commands:**\n` +
          `\`!monitor ci <repo> [--branch=main] [--action=fix|notify]\`\n` +
          `\`!monitor health <url> [--action=fix|notify]\`\n` +
          `\`!monitor remove <id>\` · \`!monitor pause <id>\` · \`!monitor resume <id>\`\n` +
          `\`!monitor check <id>\` — force immediate poll\n` +
          `\`!monitors\` — list all monitors`
        );
      }
      break;
    }

    case '!monitors': {
      const allMonitors = listMonitors();
      if (allMonitors.length === 0) {
        await message.reply('No monitors configured. Use `!monitor ci <repo>` or `!monitor health <url>` to set one up.');
        break;
      }
      const lines = allMonitors.map(m => {
        const status = m.enabled ? '🔄' : '⏸️';
        const lastAgo = m.lastCheck
          ? `${Math.round((Date.now() - new Date(m.lastCheck).getTime()) / 60000)}min ago`
          : 'never';
        const typeLabel = m.type === 'github-ci'
          ? `github-ci ${m.config.repo} (${m.config.branch || '*'})`
          : `url-health ${m.config.url}`;
        return `**#${m.id}** ${status} ${typeLabel} → ${m.action} | every ${m.pollInterval}min | last: ${lastAgo}`;
      });
      await sendLongMessage(message, `**Monitors:**\n${lines.join('\n')}`, state.cwd);
      break;
    }

    case '!audit': {
      if (state.busy) {
        await message.reply('Claude is still working. Use `!stop` first.');
        break;
      }
      const validFocuses = ['full', 'design', 'qa', 'security', 'analytics', 'performance', 'product'];
      const auditFocus = arg ? arg.toLowerCase() : 'full';
      if (!validFocuses.includes(auditFocus)) {
        await message.reply(`Unknown focus: "${arg}". Options: ${validFocuses.join(', ')}`);
        break;
      }
      state.sessionId = null; // audit starts fresh
      const auditPrompt = buildAuditPrompt(auditFocus, state.cwd);
      const auditLabel = auditFocus === 'full' ? 'full audit' : `${auditFocus} audit`;
      await message.reply(`Starting **${auditLabel}** of \`${state.cwd}\`...`);
      const auditPersonalityFile = getPersonalityFile(state.personality);
      await message.channel.sendTyping();
      const auditTypingInterval = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
      try {
        const auditResult = await runClaudeWithContinuation(auditPrompt, {
          personalityFile: auditPersonalityFile,
          identity: state.identity,
          cwd: state.cwd,
          channelState: state,
          discordChannel: message.channel,
        }, message.channel);
        if (auditResult.sessionId) {
          state.sessionId = auditResult.sessionId;
          saveChannelState(message.channel.id, state);
        }
        if (!auditResult.stopped) await sendLongMessage(message, auditResult.text, state.cwd);
      } catch (err) {
        const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
        await message.reply(`Audit error: ${errorMsg}`).catch(() => {});
        sendErrorAlert(err, { source: 'audit command', channel: message.channel.id });
      } finally {
        clearInterval(auditTypingInterval);
      }
      break;
    }

    case '!commands': {
      await message.reply(
        `**Available Commands:**\n` +
        `\`!stop\` \`!clear\` \`!kill\` \`!killall\` \`!restart\` \`!cancel\`\n` +
        `\`!status\` \`!processes\` \`!btw\` \`!cd\` \`!ls\`\n` +
        `\`!startproject\` \`!audit\` \`!name\` \`!identity\`\n` +
        `\`!personality\` \`!personalities\`\n` +
        `\`!tasks\` \`!done\`\n` +
        `\`!schedule\` \`!schedules\` \`!unschedule\` \`!autoschedule\`\n` +
        `\`!queue\` \`!queued\` \`!dequeue\`\n` +
        `\`!monitor\` \`!monitors\`\n` +
        `\`!briefing\` \`!weekly\` \`!email\` \`!help\` \`!commands\`\n\n` +
        `Use \`!help\` for detailed descriptions.`
      );
      break;
    }

    default:
      return false;
  }
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
  console.log(`Discord bot logged in as ${client.user.tag}`);
  console.log(`Bot is in ${client.guilds.cache.size} server(s)`);
  client.guilds.cache.forEach(g => console.log(` - ${g.name} (${g.id})`));
  console.log(`Default personality: ${DEFAULT_PERSONALITY}`);
  console.log(`Workspace: ${DEFAULT_WORKSPACE}`);
  console.log(`Max turns: ${DEFAULT_MAX_TURNS} | Timeout: ${MAX_TIMEOUT / 60000}min`);

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
      if (ch) ch.send("I'm back! Restart complete.").catch(() => {});
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

  // Start user-created schedules
  startAllSchedules(client);

  // Start background task queue runner
  const { startQueueRunner } = require('./queue-runner');
  startQueueRunner(client);

  // Start event monitors (CI, health checks)
  const { startMonitorRunner } = require('./monitor-runner');
  startMonitorRunner(client);

  // Auto-resume interrupted work after a crash (not a clean !restart)
  if (!wasCleanShutdown && !wasRolledBack) {
    setTimeout(async () => {
      for (const [channelId, savedState] of Object.entries(_savedChannelStates)) {
        if (!savedState.activeTask) continue;

        const task = savedState.activeTask;
        const state = getChannel(channelId);

        // Safety: don't retry more than 2 times
        if ((task.resumeAttempts || 0) >= 2) {
          console.log(`[auto-resume] Giving up on channel ${channelId} after ${task.resumeAttempts} attempts`);
          state.activeTask = null;
          saveChannelState(channelId, state);
          const ch = client.channels.cache.get(channelId);
          if (ch) ch.send('*I crashed while working and failed to resume after 2 attempts. Send your request again if needed.*').catch(() => {});
          continue;
        }

        // Increment attempt counter
        task.resumeAttempts = (task.resumeAttempts || 0) + 1;
        state.activeTask = task;
        saveChannelState(channelId, state);
        flushPendingWrites();

        const ch = client.channels.cache.get(channelId);
        if (!ch) {
          console.log(`[auto-resume] Channel ${channelId} not in cache, skipping`);
          continue;
        }

        console.log(`[auto-resume] Resuming work in channel ${channelId} (attempt ${task.resumeAttempts}/2)`);
        await ch.send(`*I crashed while working on your request. Resuming now... (attempt ${task.resumeAttempts}/2)*`).catch(() => {});
        await ch.sendTyping().catch(() => {});
        const typingInterval = setInterval(() => ch.sendTyping().catch(() => {}), 8000);

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
            }, ch);
          } catch (err) {
            // If session resume fails, try fresh with the original prompt
            if (state.sessionId) {
              console.log('[auto-resume] Session resume failed, retrying fresh:', err.message);
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
            // Send result to the channel directly
            const lines = result.text.split('\n');
            let chunk = '';
            for (const line of lines) {
              if ((chunk + '\n' + line).length > 1990) {
                await ch.send(chunk).catch(() => {});
                chunk = line;
              } else {
                chunk = chunk ? chunk + '\n' + line : line;
              }
            }
            if (chunk) await ch.send(chunk).catch(() => {});
          }

          // Success — clear active task
          state.activeTask = null;
          saveChannelState(channelId, state);
          console.log(`[auto-resume] Successfully resumed work in channel ${channelId}`);
        } catch (err) {
          console.error(`[auto-resume] Failed for channel ${channelId}:`, err.message);
          await ch.send(`*Auto-resume failed: ${err.message.substring(0, 200)}. Send another message to retry manually.*`).catch(() => {});
          sendErrorAlert(err, { source: 'auto-resume', channel: channelId });
        } finally {
          clearInterval(typingInterval);
          state.busy = false;
          state.startedAt = null;
          state.progress = freshProgress();
        }
      }
    }, 10000); // 10s delay for Discord cache to populate
  }
});

async function processQueue(state) {
  if (!state.queue.length) return;

  // Combine all queued messages into one prompt
  const queued = state.queue.splice(0);
  const combined = queued.length === 1
    ? queued[0].content
    : '[Additional messages from user while you were working]\n' + queued.map(q => `- ${q.content}`).join('\n');

  // Reply threaded to the last queued message
  const replyTarget = queued[queued.length - 1].message;
  const personalityFile = getPersonalityFile(state.personality);

  await replyTarget.channel.sendTyping();
  const typingInterval = setInterval(() => {
    replyTarget.channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    state.busy = true;
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
      result = await runClaudeWithContinuation(combined, queueOpts, replyTarget.channel);
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
        await replyTarget.channel.send('*Process was interrupted unexpectedly — I stopped without finishing. Send another message to continue.*').catch(() => {});
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
        await replyTarget.channel.send(`*— ${parts.join(' · ')} —*`).catch(() => {});
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
    // Recursively drain if more messages came in during processing
    await processQueue(state);
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

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
      await message.reply(`Command failed: ${err.message}`).catch(() => {});
      return;
    }
  }

  // Handle pending preview device selection
  if (state._pendingPreview) {
    const reply = message.content.trim().toLowerCase();
    const port = state._pendingPreview;
    if (['local', 'localhost', 'pc', 'computer', 'same'].includes(reply)) {
      state._pendingPreview = null;
      await message.reply(`**Open on this PC:** http://localhost:${port}`);
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
    const handled = await handleWizardMessage(state, message);
    if (handled) return;
  }

  // Ignore empty messages (e.g. stickers, attachments with no text)
  if (!message.content.trim()) return;

  // If Claude is already working, queue the message
  if (state.busy) {
    state.queue.push({ message, content: message.content });
    saveChannelState(message.channel.id, state); // persist queue for crash recovery
    const pos = state.queue.length;
    if (pos >= 5) {
      await message.reply(`Queued (#${pos}) — queue is getting long. Use \`!stop\` to interrupt if needed.`);
    } else {
      await message.reply(`Queued (#${pos}) — I'll get to that next.`);
    }
    return;
  }

  const personalityFile = getPersonalityFile(state.personality);

  // Keep typing indicator alive
  await message.channel.sendTyping();
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    // Track active task so we can resume after crash/restart
    state.activeTask = {
      prompt: message.content.substring(0, 500),
      channelId: message.channel.id,
      startedAt: new Date().toISOString(),
      resumeAttempts: 0,
    };
    saveChannelState(message.channel.id, state);
    flushPendingWrites();

    let result;
    const claudeOpts = {
      sessionId: state.sessionId,
      personalityFile,
      identity: state.identity,
      cwd: state.cwd,
      channelState: state,
      discordChannel: message.channel,
    };
    try {
      result = await runClaudeWithContinuation(message.content, claudeOpts, message.channel);
    } catch (err) {
      if (state.sessionId) {
        console.log('Session resume failed, retrying fresh:', err.message);
        state.sessionId = null;
        result = await askClaude(message.content, {
          personalityFile,
          identity: state.identity,
          cwd: state.cwd,
          channelState: state,
          discordChannel: message.channel,
        });
      } else {
        throw err;
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
        await message.channel.send('*Process was interrupted unexpectedly — I stopped without finishing. Send another message to continue.*').catch(() => {});
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
        await message.channel.send(`*— ${parts.join(' · ')} —*`).catch(() => {});
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
      await message.reply('*Hit an error — retrying with session context...*').catch(() => {});
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
    if (state.sessionId) errorParts.push('\n*Session preserved — send another message to retry.*');
    await message.reply(errorParts.join(' · ')).catch(() => {});
    sendErrorAlert(err, { source: 'message handler', channel: message.channel.id, detail: message.content.substring(0, 100) });
  } finally {
    clearInterval(typingInterval);
    state.busy = false;
    state.startedAt = null;
    state.progress = freshProgress();
    // Clear active task — work is done (or failed)
    state.activeTask = null;
    saveChannelState(message.channel.id, state);
    // Drain queued messages
    await processQueue(state);
  }
});

function start() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('DISCORD_BOT_TOKEN not set — Discord bot disabled');
    return;
  }
  client.login(token);
}

module.exports = { start, askClaude, runClaudeWithContinuation, client, getChannelState, getPersonalityFile, sendLongMessage, freshProgress, channels };
