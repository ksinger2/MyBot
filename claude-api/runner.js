/**
 * runner.js — Runner class extracted from bot.js (F20).
 *
 * Owns the entire lifecycle of a single Claude CLI invocation:
 *   - CLI arg building
 *   - System prompt assembly (delegates to system-prompt.js)
 *   - Child process spawn
 *   - Stream-json event parsing
 *   - Tool tracking, agent tracking, loop detection
 *   - Streaming sends
 *   - Stall detection, progress check-ins, hard timeout
 *   - Close/error handling, result construction
 *
 * Does NOT own: Discord/Signal handlers, ChannelProxy, !commands,
 * runClaudeWithContinuation, or any shared utilities that bot.js
 * also needs (freshProgress, pushOutput, pushRawLog, etc.).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// F5: Output scrubber — redacts secrets that might leak via prompt injection
// or accidental echoing. Applied to every streamed text block and final result.
// H1 (security re-review): extended to cover all secret formats in the container env.
const _INTERNAL_TOKEN_LITERAL = process.env.INTERNAL_API_TOKEN || '';
function scrubSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text
    // ── API key patterns ──
    .replace(/X-Internal-Token:\s*[\w-]{10,}/gi, 'X-Internal-Token: [REDACTED]')
    .replace(/Bearer\s+[\w\-.]{20,}/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_\-]{20,}/g, 'sk-[REDACTED]')           // OpenAI
    .replace(/sk_(?:live|test)_[A-Za-z0-9]{20,}/g, 'sk_[REDACTED]') // Stripe
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]')             // GitHub classic PAT
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]') // GitHub fine-grained
    .replace(/r8_[A-Za-z0-9]{20,}/g, 'r8_[REDACTED]')               // Replicate
    .replace(/AIzaSy[A-Za-z0-9_\-]{30,}/g, 'AIzaSy[REDACTED]')      // Google/Gemini
    .replace(/GOCSPX-[A-Za-z0-9_\-]{20,}/g, 'GOCSPX-[REDACTED]')   // Google OAuth secret
    // ── Password/credential patterns ──
    .replace(/"password"\s*:\s*"[^"]+"/gi, '"password": "[REDACTED]"')
    .replace(/"pass(?:word)?"\s*[:=]\s*"[^"]+"/gi, '"password": "[REDACTED]"')
    .replace(/"email"\s*:\s*"[^"@]+@[^"]+"/gi, '"email": "[REDACTED]"')
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]{10,}/gi, 'Authorization: Basic [REDACTED]')
    // ── Environment variable dumps ──
    .replace(/(?:INTERNAL_API_TOKEN|TOKEN_ENCRYPTION_KEY|BOT_UNLOCK_PIN|OPENAI_API_KEY|GEMINI_API_KEY|GH_TOKEN|SERPAPI_KEY|SPOTIFY_CLIENT_SECRET|GOOGLE_CLIENT_SECRET|ELEVENLABS_API_KEY|REPLICATE_API_TOKEN|STRIPE_SECRET_KEY|VIDEO_GEN_API_KEY|DISCORD_BOT_TOKEN|SIGNAL_OWNER_NUMBER|TICKETMASTER_API_KEY)=\S+/g,
      (m) => m.split('=')[0] + '=[REDACTED]')
    // ── Catch any remaining token-like strings from env dumps ──
    .replace(/(?:_KEY|_TOKEN|_SECRET|_PASSWORD)=["']?[^\s"']{8,}/gi, (m) => m.split('=')[0] + '=[REDACTED]');
  // Literal match for the actual INTERNAL_API_TOKEN value
  if (_INTERNAL_TOKEN_LITERAL.length >= 16) {
    out = out.replaceAll(_INTERNAL_TOKEN_LITERAL, '[REDACTED]');
  }
  return out;
}
const { buildSystemPrompt } = require('./system-prompt');
const { init: initErrorAlerting, sendErrorAlert } = require('./error-alerting');
const { appendEntry, getJournalContext } = require('./session-journal');
const { loadMemory } = require('./memory');

// These constants mirror the ones in bot.js. We accept them as constructor
// options (with defaults) so the Runner doesn't import from bot.js.
const DEFAULT_WORKSPACE = '/workspace';
const DEFAULT_MAX_TURNS = parseInt(process.env.DEFAULT_MAX_TURNS, 10) || 50;
const MAX_TIMEOUT = (parseInt(process.env.MAX_TIMEOUT_MINUTES, 10) || 90) * 60 * 1000;
const STALL_THRESHOLDS = {
  thinking: 5 * 60 * 1000,
  bash:     10 * 60 * 1000,
  default:  10 * 60 * 1000,
};
const CHECKIN_INTERVAL = 5 * 60 * 1000;

// Tool labels — duplicated here so runner.js is self-contained for logging.
const TOOL_LABELS = {
  Read: 'Reading', Write: 'Writing', Edit: 'Editing',
  Bash: 'Running command', Glob: 'Finding files', Grep: 'Searching code',
  WebSearch: 'Searching web', WebFetch: 'Fetching URL',
  Agent: 'Running sub-agent', Skill: 'Using skill',
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

function getStallThreshold(currentTool) {
  if (!currentTool) return STALL_THRESHOLDS.thinking;
  if (currentTool === 'Bash') return STALL_THRESHOLDS.bash;
  return STALL_THRESHOLDS.default;
}

/**
 * Gracefully kill a child process: SIGTERM first, then SIGKILL after timeout.
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

// Push a line to recentOutputs, keeping only the last 15
function pushOutput(progress, line) {
  if (!line) return;
  const trimmed = line.length > 200 ? line.substring(0, 197) + '...' : line;
  progress.recentOutputs.push(trimmed);
  if (progress.recentOutputs.length > 15) progress.recentOutputs.shift();
}

function pushRawLog(progress, entry) {
  const elapsed = Math.round((Date.now() - (progress._startTime || Date.now())) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  progress.rawLog.push({ ts, text: entry });
  if (progress.rawLog.length > 50) progress.rawLog.shift();
}

function freshProgress() {
  const loopDetection = require('./loop-detection');
  return {
    currentTool: null, toolDetail: '', toolHistory: [], turnCount: 0,
    lastActivity: Date.now(), recentOutputs: [],
    rawLog: [],
    stallWarned: false,
    lastLoopWarning: 0,
    lastLoopWarningKey: '',
    loopState: loopDetection.createState(),
    activeAgents: new Map(),
    completedAgents: [],
  };
}

/**
 * Runner — owns the full lifecycle of a single Claude CLI invocation.
 *
 * Usage:
 *   const result = await new Runner(prompt, opts).run();
 *
 * Returns the same shape as the old askClaude():
 *   { text, sessionId, cost, numTurns, hitTurnLimit, stopped, streamed }
 */
class Runner {
  constructor(prompt, {
    sessionId = null,
    personalityFile = null,
    identity = null,
    cwd = DEFAULT_WORKSPACE,
    maxTurns = null,
    channelState = null,
    channelProxy = null,
    discordUserId = null,
    readOnly = false,
    groupAllowedTools = undefined, // custom allowlist for group chats (overrides readOnly)
    profileContext = null,
    streamReplies = false,
    model = 'sonnet', // 'sonnet' or 'opus'
    // Injected from bot.js so runner doesn't need to import bot.js:
    freshProgressFn = null,
    saveChannelStateFn = null,
    flushPendingWritesFn = null,
  } = {}) {
    this.prompt = prompt;
    this.sessionId = sessionId;
    this.personalityFile = personalityFile;
    this.identity = identity;
    this.cwd = cwd;
    this.maxTurns = maxTurns || (channelState?.config?.maxTurns) || DEFAULT_MAX_TURNS;
    this.channelState = channelState;
    this.channelProxy = channelProxy;
    this.model = model;
    this.discordUserId = discordUserId;
    this.readOnly = readOnly;
    this.groupAllowedTools = groupAllowedTools;
    this.profileContext = profileContext;
    this.streamReplies = streamReplies;
    // Use injected functions or local fallbacks
    this._freshProgress = freshProgressFn || freshProgress;
    this._saveChannelState = saveChannelStateFn || (() => {});
    this._flushPendingWrites = flushPendingWritesFn || (() => {});
  }

  run() {
    return new Promise((resolve, reject) => {
      const {
        prompt, sessionId, personalityFile, identity, cwd, maxTurns,
        channelState, channelProxy, discordUserId, readOnly,
        groupAllowedTools, profileContext, streamReplies,
      } = this;

      // Auto-inject .claude/commands/ into project if missing
      const templateCommandsDir = path.join(__dirname, 'project-template', '.claude', 'commands');
      if (cwd !== DEFAULT_WORKSPACE && fs.existsSync(templateCommandsDir)) {
        try {
          const projectCommandsDir = path.join(cwd, '.claude', 'commands');
          if (!fs.existsSync(projectCommandsDir)) fs.mkdirSync(projectCommandsDir, { recursive: true });
          for (const f of fs.readdirSync(templateCommandsDir)) {
            const dest = path.join(projectCommandsDir, f);
            if (!fs.existsSync(dest)) fs.copyFileSync(path.join(templateCommandsDir, f), dest);
          }
        } catch {}
      }

      // Auto-load project context on new sessions
      let effectivePrompt = prompt;
      if (!sessionId) {
        const contextParts = [];
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
        if (channelState?._channelId) {
          const journalContext = getJournalContext(channelState._channelId);
          if (journalContext) contextParts.push(journalContext);
        }
        const memoryContext = loadMemory(cwd);
        if (memoryContext) contextParts.push(memoryContext);
        // Inject repair ledger + pre-flight checklist when Bianca is working on herself
        if (cwd === '/workspace/MyBot' || cwd?.startsWith('/workspace/MyBot/')) {
          try {
            const { buildRepairContext } = require('./repair-ledger');
            const repairCtx = buildRepairContext();
            if (repairCtx) contextParts.push(repairCtx);
          } catch {}
          try {
            const { buildPreflightBlock } = require('./preflight');
            const preflight = buildPreflightBlock(cwd, prompt);
            if (preflight) contextParts.push(preflight);
          } catch {}
        }
        if (contextParts.length > 0) {
          effectivePrompt = contextParts.join('\n\n') + `\n\n[Current request]:\n${prompt}`;
        }
      }

      // Build CLI args
      const args = [
        '-p', effectivePrompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--model', this.model,
        '--max-turns', String(maxTurns),
        '--dangerously-skip-permissions',
        '--mcp-config', '/app/.mcp.json',
      ];

      // Tool restrictions — group chats get a social allowlist, read-only
      // sessions get the restrictive allowlist, everyone else gets full access.
      if (groupAllowedTools) {
        // Group chat: social assistant mode — web search, links, calendar (Bash
        // for curl), sub-agents. NO Edit/Write/Grep/Glob (engineering tools).
        args.push('--allowedTools', groupAllowedTools);
      } else if (readOnly) {
        args.push(
          '--allowedTools',
          [
            'Read', 'Grep', 'Glob', 'LS',
            'WebSearch', 'TodoWrite', 'Task', // F7: WebFetch removed — exfil chain with prompt injection
          ].join(',')
        );
      }

      if (sessionId) {
        args.push('--resume', sessionId);
      }

      // Build and attach system prompt
      const systemPromptText = buildSystemPrompt({
        identity,
        personalityFile,
        readOnly,
        profileContext,
        discordUserId,
        maxTurns,
        availableAgents: AVAILABLE_AGENTS,
      });
      if (systemPromptText) {
        args.push('--append-system-prompt', systemPromptText);
      }

      // Spawn the Claude CLI child process
      const child = spawn('claude', args, {
        cwd,
        env: {
          HOME: '/home/node', CI: 'true',
          PATH: process.env.PATH,
          NODE_PATH: process.env.NODE_PATH || '',
          CHROME_PATH: process.env.CHROME_PATH || '',
          PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '',
          LANG: process.env.LANG || 'en_US.UTF-8',
          TERM: process.env.TERM || 'xterm-256color',
          // F1: passed as env var so Claude's Bash tool can expand $INTERNAL_API_TOKEN
          // in curl examples without the literal value leaking into the system prompt.
          INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN || '',
          // Image registry session key — used by /imagine to associate generated
          // images with the correct chatId. Deterministic: set by infrastructure,
          // not by Claude's prompt compliance.
          IMAGE_SESSION_KEY: channelState?._channelId || '',
          // F6: owner is trusted; gh capability is documented. Risk: prompt-injection
          // could exfiltrate via Bash — mitigated by scrubSecrets (F5).
          GH_TOKEN: process.env.GH_TOKEN || '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Track the process so it can be killed
      if (channelState) {
        channelState.process = child;
        channelState.busy = true;
        if (!channelState.startedAt) channelState.startedAt = Date.now();
        if (!channelState.progress || !channelState.progress._startTime) {
          channelState.progress = this._freshProgress();
        }
        channelState.progress._startTime = channelState.startedAt;
      }

      // Stream-json result accumulators
      let resultText = null;
      let resultSubtype = null;
      let resultSessionId = null;
      let resultCost = null;
      let resultNumTurns = 0;
      let accumulatedText = '';
      const subagentText = new Map(); // F11: per-agent text buckets so sub-agent text doesn't bleed into parent's result
      let stdoutBuf = '';
      let stderr = '';
      let currentToolInput = '';
      let lastEventWasAssistant = false;
      let streamedAny = false;
      let hitRateLimit = false;

      // --- stdout handler: stream-json event parsing ---
      child.stdout.on('data', (d) => {
        if (channelState) channelState.progress.lastActivity = Date.now();

        stdoutBuf += d;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            console.log(`[event] type=${event.type}${event.subtype ? ` subtype=${event.subtype}` : ''}${event.message?.role ? ` role=${event.message.role}` : ''}${event.parent_tool_use_id ? ` parent=${event.parent_tool_use_id}` : ''}`);

            if (event.type === 'rate_limit_event') {
              hitRateLimit = true;
              console.warn(`[rate-limit] Hit Anthropic rate limit — will notify user on close`);
            }

            const parentId = event.parent_tool_use_id || null;
            const agentObj = parentId && channelState ? channelState.progress.activeAgents.get(parentId) : null;
            const agentLabel = agentObj ? agentObj.description : null;
            if (agentObj && event.type === 'assistant' && event.message?.content?.[0]?.type === 'tool_use') {
              agentObj.lastTool = event.message.content[0].name;
              agentObj.lastDetail = summarizeToolInput(event.message.content[0].name, JSON.stringify(event.message.content[0].input || {}));
            }

            // Final result event
            if (event.type === 'result') {
              resultText = event.result || '';
              resultSubtype = event.subtype || null;
              resultSessionId = event.session_id || resultSessionId;
              resultCost = event.total_cost_usd != null ? event.total_cost_usd : resultCost;
              resultNumTurns = event.num_turns != null ? event.num_turns : resultNumTurns;
              console.log(`[result] subtype=${resultSubtype} turns=${resultNumTurns} cost=$${resultCost} text_len=${(resultText || '').length} text=${JSON.stringify((resultText || '').substring(0, 300))}`);
              continue;
            }

            if (event.session_id) resultSessionId = event.session_id;

            // Non-assistant events
            if (event.type !== 'assistant') {
              lastEventWasAssistant = false;
              if (channelState && event.message?.content) {
                for (const rb of event.message.content) {
                  if (rb.type === 'tool_result') {
                    console.log(`[tool-result] id=${rb.tool_use_id || '?'} is_error=${!!rb.is_error} content_type=${typeof rb.content}`);
                    try {
                      const ld = require('./loop-detection');
                      const resultLoopState = agentObj ? agentObj.loopState : channelState.progress.loopState;
                      ld.recordOutcomeById(
                        resultLoopState,
                        rb.tool_use_id,
                        rb,
                        rb.is_error ? rb.content : undefined
                      );
                    } catch (err) {
                      console.error('[loop-detection] outcome record error:', err.message);
                    }
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
                    let toolResultText = '';
                    if (typeof rb.content === 'string') {
                      toolResultText = rb.content;
                    } else if (Array.isArray(rb.content)) {
                      toolResultText = rb.content
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join(' ');
                    }
                    if (toolResultText) {
                      const cleaned = toolResultText
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

            // Assistant events
            if (!channelState) continue;

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
                const loopDetection = require('./loop-detection');
                const agentDesc = block.input?.description || 'sub-agent';
                const agentType = block.input?.subagent_type || 'general-purpose';
                channelState.progress.activeAgents.set(block.id, {
                  description: agentDesc,
                  type: agentType,
                  startedAt: Date.now(),
                  lastTool: null,
                  lastDetail: '',
                  loopState: loopDetection.createState(),
                });
                pushRawLog(channelState.progress, `🤖 Spawned [${agentType}]: ${agentDesc}`);
              }

              channelState.progress.currentTool = name;
              channelState.progress.toolDetail = detail;
              channelState.progress.stallWarned = false;
              const toolPrefix = agentLabel ? `  ↳ [${agentLabel}] ` : '';
              pushRawLog(channelState.progress, `${toolPrefix}⚡ ${name}${detail ? ` (${detail.length > 60 ? detail.substring(0, 57) + '...' : detail})` : ''}`);

              channelState.progress.toolHistory.push({ name, detail });
              if (channelState.progress.toolHistory.length > 10) {
                channelState.progress.toolHistory.shift();
              }
              const label = TOOL_LABELS[name] || name;
              pushOutput(channelState.progress, `🔧 ${label}${detail ? `: ${detail}` : ''}`);

              // Loop detection
              try {
                const ld = require('./loop-detection');
                const loopState = agentObj ? agentObj.loopState : channelState.progress.loopState;
                const params = block.input || {};
                ld.recordToolCall(loopState, name, params, block.id);
                const verdict = ld.detectToolCallLoop(loopState, name, params);
                if (verdict.stuck) {
                  const sameAsLast = channelState.progress.lastLoopWarningKey === verdict.warningKey;
                  if (verdict.level === 'critical') {
                    console.error(`[loop] CRITICAL ${verdict.detector} (${verdict.count}x): ${name}`);
                    if (channelProxy && !sameAsLast) {
                      channelState.progress.lastLoopWarningKey = verdict.warningKey;
                      channelProxy.send(`🛑 **Loop blocked** — ${verdict.message}`).catch(() => {});
                    }
                    if (channelState.process) {
                      try { child.kill(); } catch {}
                    }
                  } else if (verdict.level === 'warning' && channelProxy && !sameAsLast) {
                    console.warn(`[loop] WARN ${verdict.detector} (${verdict.count}x): ${name}`);
                    channelState.progress.lastLoopWarningKey = verdict.warningKey;
                    channelState.progress.lastLoopWarning = Date.now();
                    channelProxy.send(`⚠️ ${verdict.message}`).catch(() => {});
                  }
                }
              } catch (err) {
                console.error('[loop-detection] error:', err.message);
              }

              channelState.progress.currentTool = null;
              channelState.progress.toolDetail = '';

            } else if (block.type === 'text' && block.text) {
              // F11: route text to the right bucket — parent vs sub-agent
              if (parentId) {
                const existing = subagentText.get(parentId) || '';
                subagentText.set(parentId, existing + block.text);
              } else {
                accumulatedText += block.text;

                // Streaming: push each text block live (parent only — sub-agent
                // text is excluded by the parentId routing above). F5: scrubSecrets
                // redacts any leaked tokens. F4: serialized via _sendQueue.
                if (streamReplies && channelProxy) {
                  let chunk = scrubSecrets(block.text.trim());
                  // Strip auto-learn tags from streamed output (the post-result handler
                  // will extract them from the full result.text for storage)
                  chunk = chunk.replace(/\[LEARNED:\s*.+?\]/gi, '').trim();
                  if (chunk.length > 0) {
                    streamedAny = true;
                    if (!channelState._sendQueue) channelState._sendQueue = Promise.resolve();
                    channelState._sendQueue = channelState._sendQueue
                      .then(() => channelProxy.send(chunk))
                      .catch(err => console.error('[stream] partial send error:', err.message));
                  }
                }
              }

              // Flush completed lines for !btw display (both parent and sub-agent)
              const textBucket = parentId ? (subagentText.get(parentId) || '') : accumulatedText;
              const textLines = textBucket.split('\n');
              const remainder = textLines.pop();
              if (parentId) { subagentText.set(parentId, remainder); } else { accumulatedText = remainder; }
              for (const tl of textLines) {
                const trimmed = tl.trim();
                if (trimmed.length > 5) {
                  const txtPrefix = agentLabel ? `  ↳ [${agentLabel}] ` : '';
                  pushOutput(channelState.progress, `💬 ${trimmed}`);
                  pushRawLog(channelState.progress, `${txtPrefix}💭 ${trimmed}`);
                }
              }

            } else if (block.type === 'thinking') {
              const thinkPrefix = agentLabel ? `  ↳ [${agentLabel}] ` : '';
              pushRawLog(channelState.progress, `${thinkPrefix}🧠 Thinking...`);
            }
          } catch (parseErr) {
            const preview = line.substring(0, 150);
            console.log(`[parse-error] ${parseErr.message} | line: ${preview}`);
          }
        }
      });

      // --- stderr handler ---
      child.stderr.on('data', (d) => {
        stderr += d;
        if (channelState) {
          channelState.progress.lastActivity = Date.now();
          const stderrLines = d.toString().split('\n');
          for (const sl of stderrLines) {
            const trimmed = sl.trim();
            if (trimmed && trimmed.length > 3) {
              if (trimmed.startsWith('Compressing') || trimmed.startsWith('Downloading')) continue;
              const preview = trimmed.length > 120 ? trimmed.substring(0, 117) + '...' : trimmed;
              pushRawLog(channelState.progress, `⚠ ${preview}`);
              console.log(`[stderr] ${preview}`);
            }
          }
        }
      });

      // --- Hard cap timeout ---
      const hardTimeout = setTimeout(async () => {
        console.log(`[hard-timeout] Claude CLI hit hard timeout after ${MAX_TIMEOUT / 60000} minutes`);
        await forceKillProcess(child, 5000);
        if (channelState) {
          channelState.process = null;
          channelState.busy = false;
          channelState.startedAt = null;
          channelState.progress = this._freshProgress();
          this._saveChannelState(channelState._channelId, channelState);
          this._flushPendingWrites();
        }
        const timeoutErr = new Error(`Claude CLI hit hard timeout after ${MAX_TIMEOUT / 60000} minutes`);
        sendErrorAlert(timeoutErr, { source: 'askClaude hard timeout' });
        reject(timeoutErr);
      }, MAX_TIMEOUT);

      // --- Stall detector ---
      const stallCheck = setInterval(() => {
        if (!channelState) return;
        const p = channelState.progress;
        const idle = Date.now() - p.lastActivity;
        let threshold = getStallThreshold(p.currentTool);
        if (p.activeAgents.size > 0) {
          threshold = Math.max(threshold, 30 * 60 * 1000);
        }

        if (idle >= threshold * 0.8 && !p.stallWarned && channelProxy) {
          p.stallWarned = true;
          const toolInfo = p.currentTool ? `Tool: ${p.currentTool}` : 'Thinking (no tool active)';
          channelProxy.send(`⚠️ **Stall warning** — no output for ${Math.round(idle / 60000)}min. ${toolInfo}. Will kill in ${Math.round((threshold - idle) / 60000)}min if no activity.`).catch(() => {});
        }

        if (idle >= threshold) {
          forceKillProcess(child).catch(() => {});
          const lastEntries = p.rawLog.slice(-5).map(e => `[${e.ts}] ${e.text}`).join('\n');

          if (channelProxy) {
            const thresholdLabel = !p.currentTool ? 'thinking'
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
            channelProxy.send(diagLines.join('\n')).catch(() => {});
          }

          channelState.process = null;
          channelState.busy = false;
          channelState.startedAt = null;
          channelState.progress = this._freshProgress();
          const stallErr = new Error(`Claude CLI stalled — no output for ${Math.round(idle / 60000)}min (threshold: ${Math.round(threshold / 60000)}min, tool: ${p.currentTool || 'none'}, turns: ${p.turnCount})`);
          sendErrorAlert(stallErr, { source: 'askClaude stall detector' });
          reject(stallErr);
        }
      }, 30000);

      // --- Periodic check-in ---
      let lastCheckin = Date.now();
      const checkinTimer = setInterval(() => {
        if (!channelProxy || !channelState || !channelState.startedAt) return;
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
        channelProxy.send(`*Still working — ${parts.join(' · ')}*`).catch(() => {});
      }, 30000);

      // --- Close handler ---
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
          channelState.progress = this._freshProgress();
        }

        if (code === 143 || code === null) {
          return resolve({ text: '*(Process stopped)*', sessionId: channelState?.sessionId, cost: null, stopped: true });
        }

        if (code !== 0) {
          // Rate limit: CLI was cut off by Anthropic — notify user clearly.
          if (hitRateLimit) {
            console.warn(`[rate-limit] Process exited after rate limit event — notifying user`);
            if (channelProxy) {
              channelProxy.send('⏳ Hit Anthropic rate limit mid-task. Wait a minute and try again.').catch(() => {});
            }
            return resolve({ text: '', sessionId: resultSessionId, cost: resultCost, numTurns: resultNumTurns, stopped: true, rateLimited: true });
          }

          // error_max_turns: CLI exits 1 with empty text — treat as graceful turn limit,
          // not a crash. This lets runClaudeWithContinuation auto-continue as normal.
          if (resultSubtype === 'error_max_turns') {
            console.log(`[exit-recovery] error_max_turns after ${resultNumTurns} turns — resolving as hitTurnLimit`);
            return resolve({
              text: resultText || '',
              sessionId: resultSessionId,
              cost: resultCost,
              numTurns: resultNumTurns,
              hitTurnLimit: true,
              stopped: false,
              streamed: streamedAny,
            });
          }
          console.error(`[exit-error] code=${code} stderr:`, stderr.substring(0, 1000));
          const hasValidResult = resultText && resultText.length > 10;
          if (hasValidResult) {
            console.log(`[exit-recovery] CLI exited ${code} but has valid result (${resultText.length} chars, $${resultCost}) — using it`);
            return resolve({
              text: scrubSecrets(resultText),
              sessionId: resultSessionId,
              cost: resultCost,
              numTurns: resultNumTurns,
              hitTurnLimit: resultNumTurns >= maxTurns,
              stopped: false,
              streamed: streamedAny,
            });
          }
          const exitErr = new Error(`Claude CLI exited with code ${code}\n${stderr.substring(0, 300)}`);
          sendErrorAlert(exitErr, { source: 'askClaude', detail: `Exit code ${code}` });
          return reject(exitErr);
        }

        resolve({
          text: scrubSecrets(resultText || accumulatedText || ''),
          sessionId: resultSessionId,
          cost: resultCost,
          numTurns: resultNumTurns,
          hitTurnLimit: resultNumTurns >= maxTurns,
          stopped: false,
          streamed: streamedAny,
        });
      });
    });
  }
}

module.exports = { Runner };
