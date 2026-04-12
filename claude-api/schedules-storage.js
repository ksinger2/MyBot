const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

// Store in mounted .claude dir so schedules persist across container rebuilds
const SCHEDULES_FILE = path.join('/home/node/.claude', 'schedules.json');

function readStore() {
  try {
    if (!fs.existsSync(SCHEDULES_FILE)) return { schedules: [], nextId: 1 };
    const raw = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    return { schedules: raw.schedules || [], nextId: raw.nextId || 1 };
  } catch { return { schedules: [], nextId: 1 }; }
}

function writeStore(store) {
  atomicWriteJsonSync(SCHEDULES_FILE, store);
}

function loadSchedules() {
  return readStore().schedules;
}

function addSchedule({ userId, channelId, message, cronRule, description, type, cwd, timezone }) {
  const store = readStore();
  const schedule = {
    id: store.nextId++,
    userId,
    channelId,
    message,
    cronRule,
    description,
    type: type || 'reminder',
    cwd: cwd || null,
    timezone: timezone || 'America/Los_Angeles',
    createdAt: new Date().toISOString(),
    active: true,
  };
  store.schedules.push(schedule);
  writeStore(store);
  return schedule;
}

function removeSchedule(id, userId) {
  const store = readStore();
  const idx = store.schedules.findIndex(s => s.id === id && s.userId === userId);
  if (idx === -1) return null;
  const [removed] = store.schedules.splice(idx, 1);
  writeStore(store);
  return removed;
}

function getUserSchedules(userId) {
  return readStore().schedules.filter(s => s.userId === userId);
}

function formatScheduleList(schedules) {
  if (!schedules || schedules.length === 0) return null;
  return schedules.map(s => {
    const typeLabel = s.type === 'task' ? '🤖 Task' : '📝 Reminder';
    const cwdInfo = s.cwd ? ` | \`${s.cwd}\`` : '';
    return `**#${s.id}** ${typeLabel} — ${s.description}\n  ⏰ \`${s.cronRule}\` | "${s.message.length > 60 ? s.message.substring(0, 60) + '...' : s.message}"${cwdInfo}`;
  }).join('\n');
}

function updateSchedule(id, userId, fields) {
  const store = readStore();
  const sched = store.schedules.find(s => s.id === id && s.userId === userId);
  if (!sched) return null;
  const allowed = ['message', 'cronRule', 'description', 'active', 'timezone'];
  for (const key of allowed) {
    if (key in fields) sched[key] = fields[key];
  }
  sched.updatedAt = new Date().toISOString();
  writeStore(store);
  return sched;
}

function toggleSchedule(id, userId) {
  const store = readStore();
  const sched = store.schedules.find(s => s.id === id && s.userId === userId);
  if (!sched) return null;
  sched.active = !sched.active;
  sched.updatedAt = new Date().toISOString();
  writeStore(store);
  return sched;
}

module.exports = { loadSchedules, addSchedule, removeSchedule, getUserSchedules, formatScheduleList, updateSchedule, toggleSchedule };
