const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

// Store on the dedicated bot-data Docker volume so state survives rebuilds.
// Previously lived in /home/node/.claude (a bind mount shared with the Claude
// CLI config dir). That path was fragile: ownership mismatches between the
// container's `node` user and the host operator, plus Claude CLI writing its
// own files there, caused channel-state.json to be wiped on rebuilds. The
// bot-data named volume is isolated and purpose-built for bot persistence —
// same volume as user-tokens.json, user-profiles.json, and oauth-state.json.
const STATE_FILE = '/app/data/channel-state.json';
const LEGACY_STATE_FILE = '/home/node/.claude/channel-state.json';

// One-time migration: if the new location is empty but the legacy file has
// data, copy it forward. Runs at module load.
(function migrateLegacyState() {
  try {
    if (fs.existsSync(STATE_FILE)) return;
    if (!fs.existsSync(LEGACY_STATE_FILE)) return;
    const legacy = fs.readFileSync(LEGACY_STATE_FILE, 'utf8');
    if (!legacy.trim()) return;
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    atomicWriteJsonSync(STATE_FILE, JSON.parse(legacy));
    console.log('[channel-persistence] Migrated channel-state.json from legacy path to /app/data/');
  } catch (err) {
    console.error('[channel-persistence] Legacy migration failed:', err.message);
  }
})();

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
    listenToAll: state.listenToAll || false,
    pendingQueue: (state.queue || []).map(q => typeof q === 'string' ? q : q.content).filter(Boolean),
    // Set by /rebuild before the container is replaced. The next process
    // reads this on startup to send a "I just rebuilt — resend if needed"
    // notification to the channel.
    wantsRestartNotification: state.wantsRestartNotification || null,
    // Heartbeat config — { intervalMinutes, cwd } or null. Persisted so
    // periodic autonomous wakes survive container rebuilds and are restored
    // on startup by bot.js.
    heartbeat: state.heartbeat || null,
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
