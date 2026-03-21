const { listMonitors, getMonitor, updateMonitor } = require('./monitor-config');
const { pollGitHubCI, pollURLHealth } = require('./pollers');

const timers = new Map();     // monitorId -> intervalId
const fixCounts = new Map();  // monitorId -> [{ timestamp }] for rate limiting

const POLLERS = {
  'github-ci': pollGitHubCI,
  'url-health': pollURLHealth,
};

const MAX_FIXES_PER_HOUR = 3;

function startMonitorRunner(client) {
  const monitors = listMonitors().filter(m => m.enabled);
  console.log(`[monitor-runner] Loading ${monitors.length} monitor(s)...`);
  for (const mon of monitors) {
    scheduleMonitor(mon, client);
  }
}

function scheduleMonitor(monitor, client) {
  // Clear existing timer if re-scheduling
  if (timers.has(monitor.id)) clearInterval(timers.get(monitor.id));

  const intervalMs = (monitor.pollInterval || 5) * 60 * 1000;
  const timer = setInterval(() => runPoll(monitor.id, client), intervalMs);
  timers.set(monitor.id, timer);

  // Run first check after short delay
  setTimeout(() => runPoll(monitor.id, client), 5000);
  console.log(`  Monitor #${monitor.id}: ${monitor.type} (every ${monitor.pollInterval || 5}min)`);
}

function cancelMonitor(monitorId) {
  if (timers.has(monitorId)) {
    clearInterval(timers.get(monitorId));
    timers.delete(monitorId);
  }
}

function isRateLimited(monitorId) {
  const now = Date.now();
  const counts = fixCounts.get(monitorId) || [];
  // Keep only last hour
  const recent = counts.filter(ts => now - ts < 60 * 60 * 1000);
  fixCounts.set(monitorId, recent);
  return recent.length >= MAX_FIXES_PER_HOUR;
}

function recordFixAction(monitorId) {
  const counts = fixCounts.get(monitorId) || [];
  counts.push(Date.now());
  fixCounts.set(monitorId, counts);
}

async function runPoll(monitorId, client) {
  const monitor = getMonitor(monitorId);
  if (!monitor || !monitor.enabled) return;

  const poller = POLLERS[monitor.type];
  if (!poller) return;

  try {
    const result = await poller(monitor);
    updateMonitor(monitorId, { lastCheck: new Date().toISOString() });
    if (!result.changed) return;

    // Update last known state
    if (result.newState) updateMonitor(monitorId, { lastState: result.newState });

    const channel = await client.channels.fetch(monitor.channelId).catch(() => null);
    if (!channel) return;

    // Notify-only or no prompt (e.g. recovery)
    if (monitor.action === 'notify' || !result.prompt) {
      await channel.send(`**Monitor #${monitor.id}:**\n${result.summary}`).catch(() => {});
      return;
    }

    // action=fix — run Claude to diagnose and fix
    const { getChannelState, runClaudeWithContinuation, getPersonalityFile, sendLongMessage, freshProgress } = require('./bot');
    const { saveChannelState } = require('./channel-persistence');
    const state = getChannelState(monitor.channelId);

    // If channel is busy, degrade to notify
    if (state.busy) {
      await channel.send(`*Monitor #${monitor.id} alert (channel busy):*\n${result.summary}`).catch(() => {});
      return;
    }

    // Rate limit fix actions
    if (isRateLimited(monitorId)) {
      await channel.send(`**Monitor #${monitor.id}** (rate limited — ${MAX_FIXES_PER_HOUR} fixes/hr):\n${result.summary}`).catch(() => {});
      return;
    }

    recordFixAction(monitorId);
    await channel.send(`**Monitor #${monitor.id} — auto-fixing:**\n${result.summary}`).catch(() => {});

    const personalityFile = getPersonalityFile(state.personality);
    const typingInterval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);

    try {
      state.busy = true;
      state.startedAt = Date.now();
      state.progress = freshProgress();

      const fixResult = await runClaudeWithContinuation(result.prompt, {
        sessionId: state.sessionId,
        personalityFile,
        identity: state.identity,
        cwd: monitor.cwd || state.cwd,
        channelState: state,
        discordChannel: channel,
      }, channel);

      if (fixResult.sessionId) {
        state.sessionId = fixResult.sessionId;
        saveChannelState(monitor.channelId, state);
      }
      if (fixResult.text && !fixResult.stopped) {
        const fakeMsg = { reply: (opts) => channel.send(opts), channel };
        await sendLongMessage(fakeMsg, fixResult.text, monitor.cwd || state.cwd);
      }
    } catch (err) {
      await channel.send(`*Monitor #${monitor.id} fix failed: ${err.message.substring(0, 200)}*`).catch(() => {});
    } finally {
      clearInterval(typingInterval);
      state.busy = false;
      state.startedAt = null;
      state.progress = freshProgress();
    }
  } catch (err) {
    console.error(`[monitor-runner] Monitor #${monitorId} poll failed:`, err.message);
  }
}

module.exports = { startMonitorRunner, scheduleMonitor, cancelMonitor, runPoll };
