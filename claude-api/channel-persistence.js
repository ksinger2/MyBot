const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

// Store in mounted .claude dir so state persists across container rebuilds
const STATE_FILE = path.join('/home/node/.claude', 'channel-state.json');

// Debounce writes to avoid filesystem thrashing
const pendingWrites = new Map();
const DEBOUNCE_MS = 2000;

function readStore() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return {}; }
}

function writeStore(store) {
  atomicWriteJsonSync(STATE_FILE, store);
}

function saveChannelState(channelId, state, { critical = false } = {}) {
  // Only persist durable fields — skip transient runtime state
  const persistent = {
    sessionId: state.sessionId || null,
    personality: state.personality,
    identity: state.identity,
    cwd: state.cwd,
    activeTask: state.activeTask || null,
    config: state.config || null,
    pendingQueue: (state.queue || []).map(q => typeof q === 'string' ? q : q.content).filter(Boolean),
    // Set by /rebuild before the container is replaced. The next process
    // reads this on startup to send a "I just rebuilt — resend if needed"
    // notification to the channel.
    wantsRestartNotification: state.wantsRestartNotification || null,
  };

  if (critical) {
    // Flush immediately for critical state changes (activeTask, queue, completion)
    if (pendingWrites.has(channelId)) {
      clearTimeout(pendingWrites.get(channelId).timer);
      pendingWrites.delete(channelId);
    }
    try {
      const store = readStore();
      store[channelId] = persistent;
      writeStore(store);
    } catch (err) {
      console.error('Failed to persist critical channel state:', err.message);
    }
    return;
  }

  // Debounce: schedule write, cancel previous pending write for this channel
  if (pendingWrites.has(channelId)) {
    clearTimeout(pendingWrites.get(channelId).timer);
  }
  pendingWrites.set(channelId, {
    data: persistent,
    timer: setTimeout(() => {
      flushPendingWrites();
    }, DEBOUNCE_MS),
  });
}

function flushPendingWrites() {
  if (pendingWrites.size === 0) return;
  try {
    const store = readStore();
    for (const [channelId, { data }] of pendingWrites) {
      store[channelId] = data;
    }
    writeStore(store);
    pendingWrites.clear();
  } catch (err) {
    console.error('Failed to persist channel state:', err.message);
  }
}

// activeTask older than this is treated as orphaned (e.g. crashed and never
// cleaned up) and cleared on load so it doesn't poison auto-resume forever.
const STALE_TASK_TTL_MS = 60 * 60 * 1000; // 1 hour

function loadAllChannelStates() {
  const store = readStore();
  let cleared = 0;
  for (const [id, s] of Object.entries(store)) {
    if (s && s.activeTask && s.activeTask.startedAt) {
      const age = Date.now() - new Date(s.activeTask.startedAt).getTime();
      if (!Number.isFinite(age) || age > STALE_TASK_TTL_MS) {
        s.activeTask = null;
        cleared++;
      }
    } else if (s && s.activeTask && !s.activeTask.startedAt) {
      // No timestamp at all — treat as stale
      s.activeTask = null;
      cleared++;
    }
  }
  if (cleared > 0) {
    try { writeStore(store); } catch {}
    console.log(`[channel-persistence] Cleared ${cleared} stale activeTask(s) on load`);
  }
  return store;
}

function clearChannelState(channelId) {
  if (pendingWrites.has(channelId)) {
    clearTimeout(pendingWrites.get(channelId).timer);
    pendingWrites.delete(channelId);
  }
  try {
    const store = readStore();
    delete store[channelId];
    writeStore(store);
  } catch (err) {
    console.error('Failed to clear channel state:', err.message);
  }
}

module.exports = { saveChannelState, loadAllChannelStates, clearChannelState, flushPendingWrites };
