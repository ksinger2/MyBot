const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

// Store in mounted .claude dir so queue persists across container rebuilds
const QUEUE_FILE = path.join('/home/node/.claude', 'work-queue.json');
const LOCK_FILE = QUEUE_FILE + '.lock';
const LOCK_TIMEOUT_MS = 60000; // Consider lock stale after 60s

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockTime = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      if (Date.now() - lockTime < LOCK_TIMEOUT_MS) return false;
    }
    fs.writeFileSync(LOCK_FILE, Date.now().toString(), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    return true; // Other errors — proceed without lock
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function withLock(fn) {
  let locked = false;
  for (let i = 0; i < 5; i++) {
    if (acquireLock()) { locked = true; break; }
    const start = Date.now();
    while (Date.now() - start < 100) {} // brief spin-wait
  }
  try {
    return fn();
  } finally {
    if (locked) releaseLock();
  }
}

function readStore() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return { items: [], nextId: 1 };
    const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    return { items: raw.items || [], nextId: raw.nextId || 1 };
  } catch { return { items: [], nextId: 1 }; }
}

function writeStore(store) {
  atomicWriteJsonSync(QUEUE_FILE, store);
}

function addItem({ prompt, channelId, userId, cwd, personality, identity }) {
  return withLock(() => {
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
  });
}

function getQueue() {
  return readStore().items;
}

function updateItem(id, updates) {
  return withLock(() => {
    const store = readStore();
    const item = store.items.find(i => i.id === id);
    if (!item) return null;
    Object.assign(item, updates);
    writeStore(store);
    return item;
  });
}

function removeItem(id) {
  return withLock(() => {
    const store = readStore();
    const idx = store.items.findIndex(i => i.id === id && i.status === 'pending');
    if (idx === -1) return null;
    const [removed] = store.items.splice(idx, 1);
    writeStore(store);
    return removed;
  });
}

function getPendingItems() {
  return readStore().items.filter(i => i.status === 'pending');
}

module.exports = { addItem, getQueue, updateItem, removeItem, getPendingItems };
