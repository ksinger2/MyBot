const fs = require('fs');
const path = require('path');

// Store in mounted .claude dir so tasks persist across container rebuilds
const TASKS_FILE = path.join('/home/node/.claude', 'briefing-tasks.json');

function saveTasks(text) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks: text, savedAt: new Date().toISOString() }, null, 2));
}

function loadTasks() {
  try {
    if (!fs.existsSync(TASKS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    return data.tasks || null;
  } catch { return null; }
}

function clearTasks() {
  try { fs.unlinkSync(TASKS_FILE); } catch {}
}

module.exports = { saveTasks, loadTasks, clearTasks };
