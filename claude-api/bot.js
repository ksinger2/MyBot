const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { handleWizardMessage, cancelWizard, startWizard } = require('./wizard');
const { init: initErrorAlerting, sendErrorAlert } = require('./error-alerting');
const { addSchedule, removeSchedule, getUserSchedules, formatScheduleList } = require('./schedules-storage');
const OpenAI = require('openai');
const { startAllSchedules, registerJob, cancelJob } = require('./scheduler');

const PERSONALITIES_DIR = path.join(__dirname, 'personalities');
const DEFAULT_PERSONALITY = 'tiffany_pollard';
const DEFAULT_WORKSPACE = '/workspace';
const DEFAULT_MAX_TURNS = 50;       // Let Claude work autonomously for many turns
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
      default: return '';
    }
  } catch { return ''; }
}

function freshProgress() {
  return {
    currentTool: null, toolDetail: '', toolHistory: [], turnCount: 0,
    activeBlocks: new Map(), lastActivity: Date.now(), recentOutputs: [],
    rawLog: [],           // rolling buffer of last 30 terminal-style log lines
    stallWarned: false,   // track whether we've sent a stall warning
    toolSignatures: [],   // for loop detection — last 10 tool signatures
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
  if (progress.rawLog.length > 30) progress.rawLog.shift();
}

function detectLoop(progress) {
  const sigs = progress.toolSignatures;
  if (sigs.length < 4) return false;
  // Same signature 3+ times in last 6
  const last6 = sigs.slice(-6);
  const counts = {};
  for (const s of last6) { counts[s] = (counts[s] || 0) + 1; }
  for (const c of Object.values(counts)) { if (c >= 3) return true; }
  // A-B-A-B pattern in last 4
  const last4 = sigs.slice(-4);
  if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) return true;
  return false;
}

// Push a line to recentOutputs, keeping only the last 15
function pushOutput(progress, line) {
  if (!line) return;
  const trimmed = line.length > 200 ? line.substring(0, 197) + '...' : line;
  progress.recentOutputs.push(trimmed);
  if (progress.recentOutputs.length > 15) progress.recentOutputs.shift();
}

// Per-channel state
const channels = new Map();

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
    channels.set(channelId, {
      sessionId: null,
      personality: DEFAULT_PERSONALITY,
      identity: { ...DEFAULT_IDENTITY },
      cwd: DEFAULT_WORKSPACE,
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

YOUR CAPABILITIES — You are a powerful AI assistant with the following tools. USE THEM. Never say "I can't do that" if one of these covers it:

1. **IMAGE GENERATION**: You CAN generate images! Run: curl -s -X POST http://localhost:3400/imagine -H "Content-Type: application/json" -d '{"prompt":"your detailed description here"}' — returns a file path. Include that path in your response so Discord attaches it. Use this when asked to draw, generate, create, or send any image/picture/photo/artwork.

2. **WEB BROWSING / GOOGLE**: You have a headless Chromium browser via Playwright MCP tools. You can navigate to websites, take screenshots, click elements, fill forms, and extract content. When asked to look something up, google something, check a website, or find information online — USE THE BROWSER. You can also use WebSearch and WebFetch tools.

3. **CODE & FILE OPERATIONS**: You can read, write, edit, and create any files. You can run any shell command. You can search codebases with Grep/Glob. You ARE a full software engineer — you build features, fix bugs, refactor code, write tests.

4. **DOCKER ACCESS**: You can run \`docker ps\`, \`docker restart\`, \`docker compose up -d --build\`, etc. When you make code changes that need a rebuild, just do it yourself — don't tell the user to do it. The project docker-compose.yml is at /workspace/MyBot/docker-compose.yml.

5. **GIT & GITHUB**: You can commit, push, create branches, open PRs, check CI status — full git workflow. IMPORTANT: When making git commits, ALWAYS add this trailer to your commit messages: "Co-Authored-By: Claude Code (${identity ? identity.name : 'Bot'}) <noreply@anthropic.com>" — this identifies which bot personality pushed the change.

6. **SUB-AGENTS**: You have the Agent tool to spawn focused sub-agents. ALWAYS use sub-agents when a task has 3+ independent steps — launch them in parallel. Examples: research multiple topics simultaneously, write multiple files at once, run tests while writing docs. A single message can launch multiple agents. This is your primary way to work fast.

7. **MULTIPLE PROJECTS**: Your workspace is /workspace/ which contains multiple projects. You can cd between them, work on any of them, and even coordinate across projects.

NEVER say you can't do something if one of these capabilities covers it. Try first, explain only if it actually fails.

AUTONOMY: You are fully autonomous. Never stop to ask the user for confirmation unless it involves spending money, sending emails/messages, or destructive operations (deleting repos, dropping databases). If something fails, try a different approach. If stuck after 3 attempts, summarize what you tried, then move on. The user CANNOT respond while you're running — never wait for input. You have up to ${maxTurns} turns.

ORCHESTRATION RULE: You are an ORCHESTRATOR, not a worker. For any task with multiple independent parts, ALWAYS use the Agent tool to spawn sub-agents in parallel. Do NOT do sequential work yourself when agents can work simultaneously. Example: if asked to "create 3 endpoints and test them," spawn one agent per endpoint, then test. Think like a manager delegating to a team. Only do work directly yourself when it's a single atomic step or when steps are truly sequential dependencies.`);
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

          // Final result event from Claude CLI
          if (event.type === 'result') {
            resultText = event.result || '';
            resultSessionId = event.session_id || resultSessionId;
            resultCost = event.total_cost_usd || resultCost;
            resultNumTurns = event.num_turns || resultNumTurns;
            continue;
          }

          // Track session ID from any event
          if (event.session_id) resultSessionId = event.session_id;

          // New assistant turn
          if (event.type === 'assistant') {
            if (channelState) {
              channelState.progress.turnCount++;
              pushRawLog(channelState.progress, `── Turn ${channelState.progress.turnCount} ──`);
            }
            continue;
          }

          // Content block events (tool use + text tracking)
          const inner = event.type === 'stream_event' ? event.event : event;
          if (!inner) continue;

          // DEBUG: Log event types to understand CLI output structure
          if (channelState && inner?.type) {
            console.log('EVENT:', JSON.stringify({ type: event.type, innerType: inner.type, hasBlock: !!inner.content_block }));
          }

          if (inner.type === 'content_block_start') {
            const block = inner.content_block;
            if (block?.type === 'tool_use' && channelState) {
              channelState.progress.currentTool = block.name;
              channelState.progress.toolDetail = '';
              channelState.progress.activeBlocks.set(inner.index, { type: 'tool_use', name: block.name });
              channelState.progress.stallWarned = false; // reset stall warning on new tool
              currentToolInput = '';
              pushRawLog(channelState.progress, `⚡ ${block.name}`);
            } else if (block?.type === 'text' && channelState) {
              channelState.progress.activeBlocks.set(inner.index, { type: 'text' });
            }
          }

          if (inner.type === 'content_block_delta') {
            if (inner.delta?.type === 'text_delta') {
              accumulatedText += inner.delta.text;
              // Capture text lines as they stream in (newline-delimited)
              if (channelState && inner.delta.text.includes('\n')) {
                const parts = accumulatedText.split('\n');
                // Keep last partial line in accumulator, flush completed lines
                accumulatedText = parts.pop();
                for (const line of parts) {
                  const trimmed = line.trim();
                  if (trimmed.length > 5) {
                    pushOutput(channelState.progress, `💬 ${trimmed}`);
                    pushRawLog(channelState.progress, `💭 ${trimmed}`);
                  }
                }
              }
            }
            if (inner.delta?.type === 'input_json_delta') {
              currentToolInput += inner.delta.partial_json;
              // Try to extract detail early for !btw
              if (channelState && channelState.progress.currentTool) {
                const detail = summarizeToolInput(channelState.progress.currentTool, currentToolInput);
                if (detail) channelState.progress.toolDetail = detail;
              }
            }
          }

          if (inner.type === 'content_block_stop' && channelState) {
            const block = channelState.progress.activeBlocks.get(inner.index);
            if (block?.type === 'tool_use') {
              const detail = summarizeToolInput(block.name, currentToolInput);
              channelState.progress.toolHistory.push({ name: block.name, detail });
              if (channelState.progress.toolHistory.length > 10) {
                channelState.progress.toolHistory.shift();
              }
              // Log completed tool to recent outputs and rawLog
              const label = TOOL_LABELS[block.name] || block.name;
              pushOutput(channelState.progress, `🔧 ${label}${detail ? `: ${detail}` : ''}`);
              pushRawLog(channelState.progress, `✓ ${block.name} done${detail ? ` (${detail.split('/').pop()})` : ''}`);

              // Loop detection — track tool signatures
              const sig = `${block.name}:${(detail || '').substring(0, 40)}`;
              channelState.progress.toolSignatures.push(sig);
              if (channelState.progress.toolSignatures.length > 10) {
                channelState.progress.toolSignatures.shift();
              }
              if (detectLoop(channelState.progress) && discordChannel) {
                discordChannel.send('⚠️ **Loop detected** — Claude appears to be repeating the same actions. Auto-killing in 60s if it continues.').catch(() => {});
                setTimeout(() => {
                  if (channelState.process && detectLoop(channelState.progress)) {
                    child.kill();
                    discordChannel.send('🛑 Killed due to detected loop.').catch(() => {});
                  }
                }, 60000);
              }

              channelState.progress.currentTool = null;
              channelState.progress.toolDetail = '';
              currentToolInput = '';
            } else if (block?.type === 'text') {
              // Flush any remaining partial line
              const remaining = accumulatedText.trim();
              if (remaining.length > 5) {
                pushOutput(channelState.progress, `💬 ${remaining}`);
              }
              accumulatedText = '';
            }
            channelState.progress.activeBlocks.delete(inner.index);
          }
        } catch {
          // Skip unparseable lines
        }
      }
    });

    child.stderr.on('data', (d) => {
      stderr += d;
      if (channelState) channelState.progress.lastActivity = Date.now();
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
        console.error('Claude CLI exited with code:', code);
        if (stderr) console.error('stderr:', stderr.substring(0, 500));
        const exitErr = new Error(`Claude CLI exited with code ${code}\n${stderr.substring(0, 300)}`);
        sendErrorAlert(exitErr, { source: 'askClaude', detail: `Exit code ${code}` });
        return reject(exitErr);
      }

      resolve({
        text: resultText || accumulatedText || '',
        sessionId: resultSessionId,
        cost: resultCost,
        numTurns: resultNumTurns,
        stopped: false,
      });
    });
  });
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
      // Kill all active processes first
      for (const [, s] of channels) {
        if (s.process) s.process.kill();
      }
      // Exit cleanly — Docker restart policy will bring the container back up
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case '!killall': {
      for (const [, s] of channels) {
        if (s.process) s.process.kill();
        s.queue = [];
      }
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
        `\`!startproject\` — Create a new project with template\n\n` +
        `**Identity:**\n` +
        `\`!name [name]\` — Show or set bot name\n` +
        `\`!identity [Name is desc]\` — Show or set identity\n` +
        `\`!personality <name>\` — Switch personality\n` +
        `\`!personalities\` — List available\n\n` +
        `**Tasks:** \`!tasks\` · \`!done <#>\` · \`!done all\`\n` +
        `**Schedule:** \`!schedule\` · \`!schedules\` · \`!unschedule <#>\`\n` +
        `**Briefing:** \`!briefing\` · \`!weekly\`\n` +
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
      if (!state.busy || !state.process) {
        await message.reply('Nothing running right now.');
        break;
      }
      const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const runtime = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      const p = state.progress;
      const lines = [`**Running ${runtime} | Turn ${p.turnCount || 1}/${DEFAULT_MAX_TURNS}**`];

      // Terminal-style activity log from rawLog
      if (p.rawLog.length > 0) {
        lines.push('```');
        for (const entry of p.rawLog) {
          lines.push(`[${entry.ts}] ${entry.text}`);
        }
        lines.push('```');
      }

      // What's happening right now
      if (p.currentTool) {
        const label = TOOL_LABELS[p.currentTool] || p.currentTool;
        lines.push(`→ **Now:** ${label}${p.toolDetail ? ` — \`${p.toolDetail}\`` : ''}`);
      } else {
        lines.push(`→ **Now:** Thinking...`);
      }

      lines.push(`\n[${p.rawLog.length} events buffered]`);

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

    case '!commands': {
      await message.reply(
        `**Available Commands:**\n` +
        `\`!stop\` \`!clear\` \`!kill\` \`!killall\` \`!restart\` \`!cancel\`\n` +
        `\`!status\` \`!processes\` \`!btw\` \`!cd\` \`!ls\`\n` +
        `\`!startproject\` \`!name\` \`!identity\`\n` +
        `\`!personality\` \`!personalities\`\n` +
        `\`!tasks\` \`!done\`\n` +
        `\`!schedule\` \`!schedules\` \`!unschedule\`\n` +
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
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

client.on('ready', () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
  console.log(`Bot is in ${client.guilds.cache.size} server(s)`);
  client.guilds.cache.forEach(g => console.log(` - ${g.name} (${g.id})`));
  console.log(`Default personality: ${DEFAULT_PERSONALITY}`);
  console.log(`Workspace: ${DEFAULT_WORKSPACE}`);
  console.log(`Max turns: ${DEFAULT_MAX_TURNS} | Timeout: ${MAX_TIMEOUT / 60000}min`);

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

  // Start scheduled briefings
  const briefings = require('./briefings');
  briefings.startScheduler(client);

  // Start user-created schedules
  startAllSchedules(client);
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
    try {
      result = await askClaude(combined, {
        sessionId: state.sessionId,
        personalityFile,
        identity: state.identity,
        cwd: state.cwd,
        channelState: state,
        discordChannel: replyTarget.channel,
      });
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
    }

    if (!result.stopped) {
      await sendLongMessage(replyTarget, result.text, state.cwd);

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

  // If a wizard is active, let it handle the message
  if (state.wizard) {
    const handled = await handleWizardMessage(state, message);
    if (handled) return;
  }

  // If Claude is already working, queue the message
  if (state.busy) {
    state.queue.push({ message, content: message.content });
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
    let result;
    try {
      result = await askClaude(message.content, {
        sessionId: state.sessionId,
        personalityFile,
        identity: state.identity,
        cwd: state.cwd,
        channelState: state,
        discordChannel: message.channel,
      });
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
    }

    if (!result.stopped) {
      await sendLongMessage(message, result.text, state.cwd);

      // Show cost and turns info
      const meta = [];
      if (result.numTurns > 1) meta.push(`${result.numTurns} turns`);
      if (result.cost) meta.push(`$${result.cost.toFixed(4)}`);
      if (meta.length) {
        console.log(`Completed: ${meta.join(' | ')}`);
      }
    }
  } catch (err) {
    console.error('Error handling message:', err.message);
    const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
    await message.reply(`Error: ${errorMsg}`).catch(() => {});
    sendErrorAlert(err, { source: 'message handler', channel: message.channel.id, detail: message.content.substring(0, 100) });
  } finally {
    clearInterval(typingInterval);
    state.busy = false;
    state.startedAt = null;
    state.progress = freshProgress();
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

module.exports = { start, askClaude, client, getChannelState };
