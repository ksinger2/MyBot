const fs = require('fs');
const path = require('path');

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
  fs.writeFileSync(STATE_FILE, JSON.stringify(store, null, 2));
}

function saveChannelState(channelId, state) {
  // Only persist durable fields — skip transient runtime state
  const persistent = {
    sessionId: state.sessionId || null,
    personality: state.personality,
    identity: state.identity,
    cwd: state.cwd,
  };

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

function loadAllChannelStates() {
  return readStore();
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
