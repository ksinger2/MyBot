const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { handleWizardMessage, cancelWizard } = require('./wizard');

const PERSONALITIES_DIR = path.join(__dirname, 'personalities');
const DEFAULT_PERSONALITY = 'tiffany_pollard';
const DEFAULT_WORKSPACE = '/workspace';
const DEFAULT_MAX_TURNS = 50;       // Let Claude work autonomously for many turns
const MAX_TIMEOUT = 30 * 60 * 1000; // 30 minutes for big tasks
const DEFAULT_IDENTITY = {
  name: 'Bianca',
  description: 'a fabulous cow named Bianca (aka Bianca Da Cow). You are a cow and you know it — work in cow puns, references to being a cow, mooing, grazing, etc. when it feels natural, but don\'t overdo it.'
};

// Per-channel state
const channels = new Map(); // channelId -> { sessionId, personality, identity, cwd, process, busy }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
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
      stderrBuf: '',   // accumulated stderr for !btw progress peeking
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

function askClaude(prompt, { sessionId = null, personalityFile = null, identity = null, cwd = DEFAULT_WORKSPACE, maxTurns = DEFAULT_MAX_TURNS, channelState = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--model', 'sonnet',
      '--max-turns', String(maxTurns),
      '--dangerously-skip-permissions',
    ];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // Combine identity + personality into a single system prompt
    // (Claude CLI only allows one of --append-system-prompt or --append-system-prompt-file)
    const systemParts = [];
    systemParts.push(`CRITICAL RULE — BREVITY: Keep responses SHORT. Use bullet points, not paragraphs. 1-3 sentences per point MAX. No walls of text. No long intros or outros. Get to the point FAST. Your responses should be EASY TO SKIM. If you can say it in one sentence, do NOT use three. This is a Discord chat, not an essay.

CRITICAL RULE — IMAGE ATTACHMENTS: Whenever you generate, save, or display any image files, you MUST include their full absolute file paths in your text response (e.g. /workspace/BookFactory/output/book_id/page_01.png). This is required so the Discord bot can attach the images to the message. List every image path on its own line. Do NOT rely on tool output alone — the path must appear in your final text response.

NOTE — DOCKER ACCESS: You have full Docker access. You can run \`docker ps\`, \`docker restart\`, \`docker compose up -d --build\`, etc. When you make code changes that need a rebuild, just do it yourself — don't tell the user to do it. The project docker-compose.yml is at /workspace/MyBot/docker-compose.yml.`);
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
      channelState.stderrBuf = '';
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (channelState) channelState.stderrBuf += d;
    });

    const timeout = setTimeout(() => {
      child.kill();
      if (channelState) {
        channelState.process = null;
        channelState.busy = false;
        channelState.startedAt = null;
        channelState.stderrBuf = '';
      }
      reject(new Error(`Claude CLI timed out after ${MAX_TIMEOUT / 60000} minutes`));
    }, MAX_TIMEOUT);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (channelState) {
        channelState.process = null;
        channelState.busy = false;
        channelState.startedAt = null;
        channelState.stderrBuf = '';
      }

      // code 143 = killed by !stop, not an error
      if (code === 143 || code === null) {
        return resolve({ text: '*(Process stopped)*', sessionId: channelState?.sessionId, cost: null, stopped: true });
      }

      if (code !== 0) {
        console.error('Claude CLI exited with code:', code);
        if (stderr) console.error('stderr:', stderr.substring(0, 500));
        if (stdout) console.error('stdout:', stdout.substring(0, 500));
        return reject(new Error(`Claude CLI exited with code ${code}\n${(stderr || stdout).substring(0, 300)}`));
      }

      try {
        const parsed = JSON.parse(stdout);
        const text = parsed.result || parsed.text || stdout.trim();
        const newSessionId = parsed.session_id || null;
        const numTurns = parsed.num_turns || 0;
        const cost = parsed.total_cost_usd || 0;
        resolve({ text, sessionId: newSessionId, cost, numTurns, stopped: false });
      } catch {
        resolve({ text: stdout.trim(), sessionId: null, cost: null, stopped: false });
      }
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
      if (r.length <= 1900) { out.push(r); break; }
      let splitAt = r.lastIndexOf('\n', 1900);
      if (splitAt < 500) splitAt = 1900;
      out.push(r.substring(0, splitAt));
      r = r.substring(splitAt);
    }
    return out;
  })();

  if (typeof remaining === 'string') chunks.push(remaining);
  else chunks.push(...remaining);

  // Send first chunk with any image attachments
  await message.reply({ content: chunks[0], files: files.length ? files : undefined });

  for (let i = 1; i < chunks.length && i < 8; i++) {
    await message.channel.send(chunks[i]);
  }
  if (chunks.length > 8) {
    await message.channel.send(`*(${chunks.length - 8} more chunks truncated)*`);
  }
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
        await message.reply('Stopped. Session preserved — send another message to continue where it left off.');
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
        `\n\nTimeout: ${MAX_TIMEOUT / 60000}min | Max turns: ${DEFAULT_MAX_TURNS}`
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
      }
      channels.clear();
      await message.reply('All processes killed and all sessions destroyed across every channel.');
      break;
    }

    case '!help': {
      await message.reply(
        `**Claude Code Bot — Commands:**\n\n` +
        `**Control:**\n` +
        `\`!stop\` — Pause Claude mid-task (session preserved, can continue)\n` +
        `\`!clear\` — Clear conversation context (wipe memory, keep working dir)\n` +
        `\`!kill\` — Hard kill: stop process + destroy session (full reset)\n` +
        `\`!killall\` — Kill everything across all channels\n` +
        `\`!restart\` — Restart the bot container (applies code changes)\n` +
        `\`!status\` — Show what's running and session info\n\n` +
        `\`!processes\` — Show active Claude processes and resource usage\n` +
        `\`!btw\` — Peek at Claude's progress while it's working (non-destructive)\n` +
        `\`!cancel\` — Cancel an active wizard\n\n` +
        `**Workspace:**\n` +
        `\`!cd <path>\` — Change project directory\n` +
        `\`!cd\` — Show current directory\n` +
        `\`!ls [path]\` — List files\n` +
        `\`!startproject\` — Create a new project with Claude Code template + git setup\n\n` +
        `**Identity & Personality:**\n` +
        `\`!name [name]\` — Show or set bot name\n` +
        `\`!identity [Name is description]\` — Show or set full identity\n` +
        `\`!personality <name>\` — Switch personality (voice/style)\n` +
        `\`!personalities\` — List available\n\n` +
        `**Briefing:**\n` +
        `\`!briefing\` — Send the morning briefing now (stocks, weather, news, motivation)\n` +
        `\`!weekly\` — Send the weekly preview now (week ahead, goals, events)\n\n` +
        `**Email:**\n` +
        `\`!email <who and what>\` — Draft 3 professional email options (e.g. \`!email my boss about taking Friday off\`)\n\n` +
        `**How it works:**\n` +
        `Just type what you want built. Claude Code runs autonomously in your workspace — it reads files, writes code, runs commands, commits, pushes.\n\n` +
        `Each message continues the same session, so Claude remembers everything. Use \`!stop\` to interrupt, \`!clear\` to start over.\n\n` +
        `Current: **${state.identity.name}** | ${state.personality} | \`${state.cwd}\` | ${state.busy ? '🔄 WORKING' : (state.sessionId ? '💤 idle' : '⚫ no session')}`
      );
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
        });
        if (result.sessionId) emailState.sessionId = result.sessionId;
        if (!result.stopped) await sendLongMessage(message, result.text, emailState.cwd);
      } catch (err) {
        const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
        await message.reply(`Error: ${errorMsg}`).catch(() => {});
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

      // Get last ~500 chars of stderr, trimmed to last complete line
      let activity = state.stderrBuf || '';
      if (activity.length > 500) {
        activity = activity.substring(activity.length - 500);
        const firstNewline = activity.indexOf('\n');
        if (firstNewline > 0) activity = activity.substring(firstNewline + 1);
      }
      activity = activity.trim();

      const pid = state.process.pid || 'unknown';
      const activityBlock = activity
        ? `\n**Recent activity:**\n\`\`\`\n${activity}\n\`\`\``
        : '\n*(No stderr output yet — still starting up)*';

      await message.reply(`**Running for ${runtime}** | PID ${pid}${activityBlock}`);
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

    case '!commands': {
      await message.reply(
        `**Available Commands:**\n` +
        `\`!stop\` \`!clear\` \`!kill\` \`!killall\` \`!restart\` \`!cancel\`\n` +
        `\`!status\` \`!processes\` \`!btw\` \`!cd\` \`!ls\`\n` +
        `\`!startproject\` \`!name\` \`!identity\`\n` +
        `\`!personality\` \`!personalities\`\n` +
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

  // Start scheduled briefings
  const briefings = require('./briefings');
  briefings.startScheduler(client);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const state = getChannel(message.channel.id);

  // Handle commands — also cancel any active wizard when a command is issued
  if (message.content.startsWith('!')) {
    if (state.wizard && message.content.trim().toLowerCase() !== '!cancel') {
      state.wizard = null; // silently cancel wizard on any command
    }
    const handled = await handleCommand(message);
    if (handled) return;
  }

  // If a wizard is active, let it handle the message
  if (state.wizard) {
    const handled = await handleWizardMessage(state, message);
    if (handled) return;
  }

  // If Claude is already working, queue message as info
  if (state.busy) {
    await message.reply('Claude is still working on the previous task. Use `!stop` to interrupt, or wait for it to finish.');
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
  } finally {
    clearInterval(typingInterval);
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
