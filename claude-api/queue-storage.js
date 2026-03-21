const fs = require('fs');
const path = require('path');

// Store in mounted .claude dir so queue persists across container rebuilds
const QUEUE_FILE = path.join('/home/node/.claude', 'work-queue.json');

function readStore() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return { items: [], nextId: 1 };
    const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    return { items: raw.items || [], nextId: raw.nextId || 1 };
  } catch { return { items: [], nextId: 1 }; }
}

function writeStore(store) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(store, null, 2));
}

function addItem({ prompt, channelId, userId, cwd, personality, identity }) {
  const store = readStore();
  const item = {
    id: store.nextId++,
    prompt,
    channelId,
    userId,
    cwd,
    personality,
    identity,
    status: 'pending',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    resultSummary: null,
    error: null,
  };
  store.items.push(item);
  writeStore(store);
  return item;
}

function getQueue() {
  return readStore().items;
}

function updateItem(id, updates) {
  const store = readStore();
  const item = store.items.find(i => i.id === id);
  if (!item) return null;
  Object.assign(item, updates);
  writeStore(store);
  return item;
}

function removeItem(id) {
  const store = readStore();
  const idx = store.items.findIndex(i => i.id === id && i.status === 'pending');
  if (idx === -1) return null;
  const [removed] = store.items.splice(idx, 1);
  writeStore(store);
  return removed;
}

function getPendingItems() {
  return readStore().items.filter(i => i.status === 'pending');
}

module.exports = { addItem, getQueue, updateItem, removeItem, getPendingItems };
