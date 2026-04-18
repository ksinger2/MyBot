const { listMonitors, getMonitor, updateMonitor } = require('./monitor-config');
const { pollGitHubCI, pollURLHealth } = require('./pollers');

const timers = new Map();     // monitorId -> intervalId
const fixCounts = new Map();  // monitorId -> [{ timestamp }] for rate limiting

// L8: cumulative auto-fix Claude cost per UTC day, across ALL monitors.
// A misconfigured monitor that keeps triggering auto-fixes can otherwise drain
// the Anthropic budget overnight even though MAX_FIXES_PER_HOUR limits frequency.
// Map<'YYYY-MM-DD', number>. We keep only today's entry — old entries get GC'd
// naturally on rollover since we only read/write the current UTC date string.
const _dailyAutoFixCost = new Map();
const MAX_AUTO_FIX_COST_PER_DAY_USD = parseFloat(process.env.MAX_AUTO_FIX_COST_PER_DAY_USD) || 5.00;

function _todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function _getDailyAutoFixCost() {
  const today = _todayUTC();
  // Drop stale entries so the map never grows unbounded.
  for (const key of _dailyAutoFixCost.keys()) {
    if (key !== today) _dailyAutoFixCost.delete(key);
  }
  return _dailyAutoFixCost.get(today) || 0;
}

function _addDailyAutoFixCost(usd) {
  if (!usd || !Number.isFinite(usd) || usd <= 0) return;
  const today = _todayUTC();
  _dailyAutoFixCost.set(today, (_dailyAutoFixCost.get(today) || 0) + usd);
}

const POLLERS = {
  'github-ci': pollGitHubCI,
  'url-health': pollURLHealth,
};

const MAX_FIXES_PER_HOUR = 3;

function startMonitorRunner() {
  const monitors = listMonitors().filter(m => m.enabled);
  console.log(`[monitor-runner] Loading ${monitors.length} monitor(s)...`);
  for (const mon of monitors) {
    scheduleMonitor(mon);
  }
}

function scheduleMonitor(monitor) {
  if (timers.has(monitor.id)) clearInterval(timers.get(monitor.id));

  const intervalMs = (monitor.pollInterval || 5) * 60 * 1000;
  const timer = setInterval(() => runPoll(monitor.id), intervalMs);
  timers.set(monitor.id, timer);

  setTimeout(() => runPoll(monitor.id), 5000);
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

async function runPoll(monitorId) {
  const monitor = getMonitor(monitorId);
  if (!monitor || !monitor.enabled) return;

  const poller = POLLERS[monitor.type];
  if (!poller) return;

  try {
    const result = await poller(monitor);
    updateMonitor(monitorId, { lastCheck: new Date().toISOString() });
    if (!result.changed) return;
    if (result.newState) updateMonitor(monitorId, { lastState: result.newState });

    // Signal-only delivery. monitor.channelId is expected to be a Signal
    // chat id (or `signal:<chatId>`); if it's not we skip the send.
    const { signalAdapter } = require('./bot');
    if (!signalAdapter || !signalAdapter.ready) return;
    const chatId = (monitor.channelId || '').replace(/^signal:/, '');
    if (!chatId) return;
    const send = (text) => signalAdapter.sendMessage(chatId, text).catch(() => {});

    // Notify-only or no prompt (e.g. recovery)
    if (monitor.action === 'notify' || !result.prompt) {
      await send(`Monitor #${monitor.id}:\n${result.summary}`);
      return;
    }

    // action=fix — run Claude to diagnose and fix
    const { getChannelState, runClaudeWithContinuation, getPersonalityFile, sendLongMessage, freshProgress } = require('./bot');
    const { saveChannelState } = require('./channel-persistence');
    const state = getChannelState(monitor.channelId);

    if (state.busy) {
      await send(`Monitor #${monitor.id} alert (channel busy):\n${result.summary}`);
      return;
    }

    if (isRateLimited(monitorId)) {
      await send(`Monitor #${monitor.id} (rate limited — ${MAX_FIXES_PER_HOUR} fixes/hr):\n${result.summary}`);
      return;
    }

    const spentToday = _getDailyAutoFixCost();
    if (spentToday >= MAX_AUTO_FIX_COST_PER_DAY_USD) {
      console.log(`[monitor] daily auto-fix cost cap reached ($${spentToday.toFixed(4)}) — skipping fix dispatch until tomorrow`);
      await send(`Monitor #${monitor.id} (daily cost cap $${MAX_AUTO_FIX_COST_PER_DAY_USD.toFixed(2)} reached — notify only):\n${result.summary}`);
      return;
    }

    recordFixAction(monitorId);
    await send(`Monitor #${monitor.id} — auto-fixing:\n${result.summary}`);

    const personalityFile = getPersonalityFile(state.personality);
    const typingInterval = setInterval(() => signalAdapter.sendTyping(chatId).catch(() => {}), 8000);

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
      }, null);

      if (fixResult.sessionId) {
        state.sessionId = fixResult.sessionId;
        saveChannelState(monitor.channelId, state);
      }
      if (fixResult && fixResult.cost) {
        _addDailyAutoFixCost(fixResult.cost);
        const spent = _getDailyAutoFixCost();
        if (spent >= MAX_AUTO_FIX_COST_PER_DAY_USD) {
          console.log(`[monitor] daily auto-fix cost cap just crossed: $${spent.toFixed(4)} / $${MAX_AUTO_FIX_COST_PER_DAY_USD.toFixed(2)}`);
        }
      }
      if (fixResult.text && !fixResult.stopped) {
        const fakeMsg = { _signalChatId: chatId, channel: { id: monitor.channelId } };
        await sendLongMessage(fakeMsg, fixResult.text, monitor.cwd || state.cwd);
      }
    } catch (err) {
      await send(`Monitor #${monitor.id} fix failed: ${err.message.substring(0, 200)}`);
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
