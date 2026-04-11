const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

// Store in mounted .claude dir so tasks persist across container rebuilds
const TASKS_FILE = path.join('/home/node/.claude', 'briefing-tasks.json');

function readStore() {
  try {
    if (!fs.existsSync(TASKS_FILE)) return { tasks: [], nextId: 1 };
    const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));

    // Auto-migrate old string format
    if (typeof raw.tasks === 'string') {
      const lines = raw.tasks.split('\n').map(l => l.replace(/^[-•☐☑\s]+/, '').trim()).filter(Boolean);
      const migrated = {
        tasks: lines.map((text, i) => ({ id: i + 1, text, done: false, addedAt: raw.savedAt || new Date().toISOString(), doneAt: null })),
        nextId: lines.length + 1,
      };
      writeStore(migrated);
      return migrated;
    }

    return { tasks: raw.tasks || [], nextId: raw.nextId || 1 };
  } catch { return { tasks: [], nextId: 1 }; }
}

function writeStore(store) {
  atomicWriteJsonSync(TASKS_FILE, store);
}

function loadActiveTasks() {
  const store = readStore();
  return store.tasks.filter(t => !t.done);
}

function addTasks(textBlock) {
  if (!textBlock || !textBlock.trim()) return;
  const store = readStore();
  const lines = textBlock.split('\n').map(l => l.replace(/^[-•☐☑\d.\s]+/, '').trim()).filter(Boolean);
  for (const text of lines) {
    store.tasks.push({ id: store.nextId++, text, done: false, addedAt: new Date().toISOString(), doneAt: null });
  }
  writeStore(store);
}

function markDone(idOrAll) {
  const store = readStore();
  const active = store.tasks.filter(t => !t.done);

  if (idOrAll === 'all') {
    if (active.length === 0) return 'No active tasks to mark done.';
    active.forEach(t => { t.done = true; t.doneAt = new Date().toISOString(); });
    writeStore(store);
    return `Marked all ${active.length} task(s) done!`;
  }

  const id = parseInt(idOrAll, 10);
  if (isNaN(id)) return 'Usage: `!done <number>` or `!done all`';

  const task = store.tasks.find(t => t.id === id && !t.done);
  if (!task) return `No active task with ID ${id}. Use \`!tasks\` to see your list.`;

  task.done = true;
  task.doneAt = new Date().toISOString();
  writeStore(store);
  return `Done: ~~${task.text}~~`;
}

function formatTaskList(tasks) {
  if (!tasks || tasks.length === 0) return null;
  return tasks.map(t => {
    const check = t.done ? '☑' : '☐';
    return `${check} **#${t.id}** — ${t.text}`;
  }).join('\n');
}

module.exports = { loadActiveTasks, addTasks, markDone, formatTaskList };
