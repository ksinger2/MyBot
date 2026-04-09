/**
 * Task Ledger — tracks background agent work (OpenClaw pattern).
 *
 * Records all spawned sub-agents and their results.
 * Enables inspection via !tasks and audit trail for autonomous work.
 */

const fs = require('fs');
const path = require('path');

const LEDGER_FILE = path.join('/home/node/.claude', 'task-ledger.json');
const MAX_COMPLETED = 50; // Keep last 50 completed tasks

function readLedger() {
  try {
    if (!fs.existsSync(LEDGER_FILE)) return { tasks: [], nextId: 1 };
    return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch { return { tasks: [], nextId: 1 }; }
}

function writeLedger(ledger) {
  try {
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
  } catch (err) {
    console.error('[task-ledger] Write error:', err.message);
  }
}

/**
 * Register a new background task.
 * @param {object} opts
 * @param {string} opts.description - What the agent is doing
 * @param {string} opts.channelId - Originating channel
 * @param {string} [opts.parentTaskId] - Parent task if nested
 * @param {string} [opts.agentType] - Type of sub-agent
 * @returns {object} The created task
 */
function registerTask({ description, channelId, parentTaskId = null, agentType = null }) {
  const ledger = readLedger();
  const task = {
    id: ledger.nextId++,
    description: description.substring(0, 200),
    channelId,
    parentTaskId,
    agentType,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    result: null,
    error: null,
  };
  ledger.tasks.push(task);
  writeLedger(ledger);
  return task;
}

/**
 * Mark a task as completed.
 * @param {number} taskId
 * @param {object} opts
 * @param {string} [opts.result] - Brief result summary
 * @param {string} [opts.error] - Error message if failed
 */
function completeTask(taskId, { result = null, error = null } = {}) {
  const ledger = readLedger();
  const task = ledger.tasks.find(t => t.id === taskId);
  if (!task) return null;
  task.status = error ? 'failed' : 'completed';
  task.completedAt = new Date().toISOString();
  task.result = result ? result.substring(0, 500) : null;
  task.error = error ? error.substring(0, 500) : null;

  // Trim old completed tasks
  const completed = ledger.tasks.filter(t => t.status !== 'running');
  if (completed.length > MAX_COMPLETED) {
    const toRemove = completed.slice(0, completed.length - MAX_COMPLETED);
    ledger.tasks = ledger.tasks.filter(t => !toRemove.includes(t));
  }

  writeLedger(ledger);
  return task;
}

/**
 * Get all running tasks.
 */
function getRunningTasks() {
  return readLedger().tasks.filter(t => t.status === 'running');
}

/**
 * Get recent tasks (running + last N completed).
 * @param {number} limit
 */
function getRecentTasks(limit = 10) {
  const ledger = readLedger();
  const running = ledger.tasks.filter(t => t.status === 'running');
  const completed = ledger.tasks.filter(t => t.status !== 'running').slice(-limit);
  return [...running, ...completed];
}

/**
 * Format tasks for display.
 * @param {object[]} tasks
 */
function formatTasks(tasks) {
  if (!tasks.length) return 'No background tasks.';
  return tasks.map(t => {
    const status = t.status === 'running' ? '🔄' : t.status === 'completed' ? '✅' : '❌';
    const elapsed = t.completedAt
      ? Math.round((new Date(t.completedAt) - new Date(t.startedAt)) / 1000)
      : Math.round((Date.now() - new Date(t.startedAt)) / 1000);
    const timeStr = elapsed > 60 ? `${Math.round(elapsed / 60)}m` : `${elapsed}s`;
    let line = `${status} **#${t.id}** ${t.description} (${timeStr})`;
    if (t.result) line += `\n  → ${t.result.substring(0, 100)}`;
    if (t.error) line += `\n  ⚠ ${t.error.substring(0, 100)}`;
    return line;
  }).join('\n');
}

module.exports = { registerTask, completeTask, getRunningTasks, getRecentTasks, formatTasks };
