const fs = require('fs');
const path = require('path');

const MONITOR_FILE = path.join('/home/node/.claude', 'monitor-config.json');

function readStore() {
  try {
    if (!fs.existsSync(MONITOR_FILE)) return { monitors: [], nextId: 1 };
    const raw = JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf8'));
    return { monitors: raw.monitors || [], nextId: raw.nextId || 1 };
  } catch { return { monitors: [], nextId: 1 }; }
}

function writeStore(store) {
  fs.writeFileSync(MONITOR_FILE, JSON.stringify(store, null, 2));
}

function addMonitor({ type, channelId, action, config, pollInterval, cwd }) {
  const store = readStore();
  const monitor = {
    id: store.nextId++,
    type,
    channelId,
    action: action || 'notify',
    config: config || {},
    pollInterval: pollInterval || 5,
    enabled: true,
    cwd: cwd || '/workspace',
    lastCheck: null,
    lastState: null,
    createdAt: new Date().toISOString(),
  };
  store.monitors.push(monitor);
  writeStore(store);
  return monitor;
}

function removeMonitor(id) {
  const store = readStore();
  const idx = store.monitors.findIndex(m => m.id === id);
  if (idx === -1) return null;
  const [removed] = store.monitors.splice(idx, 1);
  writeStore(store);
  return removed;
}

function listMonitors() {
  return readStore().monitors;
}

function getMonitor(id) {
  return readStore().monitors.find(m => m.id === id) || null;
}

function updateMonitor(id, updates) {
  const store = readStore();
  const monitor = store.monitors.find(m => m.id === id);
  if (!monitor) return null;
  Object.assign(monitor, updates);
  writeStore(store);
  return monitor;
}

module.exports = { addMonitor, removeMonitor, listMonitors, getMonitor, updateMonitor };
