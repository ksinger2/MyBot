/**
 * Persistent Memory System — OpenClaw-inspired file-based memory.
 *
 * - MEMORY.md: long-term durable storage (facts, preferences, decisions)
 * - memory/YYYY-MM-DD.md: daily notes (current + previous day auto-loaded)
 *
 * Memory files are stored per-project in the working directory's .claude/memory/
 * and auto-injected into the system prompt on new sessions.
 */

const fs = require('fs');
const path = require('path');

const MEMORY_DIR = '.claude/memory';
const MEMORY_FILE = 'MEMORY.md';
const MAX_MEMORY_CHARS = 3000;  // Cap memory injection to avoid bloating context
const MAX_DAILY_CHARS = 2000;

/**
 * Load persistent memory for a project.
 * Returns formatted string for system prompt injection, or empty string.
 * @param {string} cwd - Project working directory
 */
function loadMemory(cwd) {
  const parts = [];

  // Load MEMORY.md (long-term)
  const memPath = path.join(cwd, MEMORY_DIR, MEMORY_FILE);
  if (fs.existsSync(memPath)) {
    try {
      let content = fs.readFileSync(memPath, 'utf-8').trim();
      if (content) {
        if (content.length > MAX_MEMORY_CHARS) content = content.substring(0, MAX_MEMORY_CHARS) + '\n...(truncated)';
        parts.push(`[Persistent Memory — MEMORY.md]\n${content}`);
      }
    } catch {}
  }

  // Load today's daily notes
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const todayPath = path.join(cwd, MEMORY_DIR, `${today}.md`);
  if (fs.existsSync(todayPath)) {
    try {
      let content = fs.readFileSync(todayPath, 'utf-8').trim();
      if (content) {
        if (content.length > MAX_DAILY_CHARS) content = content.substring(0, MAX_DAILY_CHARS) + '\n...(truncated)';
        parts.push(`[Today's Notes — ${today}.md]\n${content}`);
      }
    } catch {}
  }

  return parts.length ? parts.join('\n\n') : '';
}

/**
 * Save a memory entry.
 * @param {string} cwd - Project directory
 * @param {string} content - Memory content to save
 * @param {string} [type='long-term'] - 'long-term' (MEMORY.md) or 'daily' (today's notes)
 */
function saveMemory(cwd, content, type = 'long-term') {
  const memDir = path.join(cwd, MEMORY_DIR);
  if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });

  if (type === 'daily') {
    const today = new Date().toISOString().split('T')[0];
    const dailyPath = path.join(memDir, `${today}.md`);
    // Append to daily notes
    const existing = fs.existsSync(dailyPath) ? fs.readFileSync(dailyPath, 'utf-8') : '';
    fs.writeFileSync(dailyPath, existing + (existing ? '\n\n' : '') + content);
    return dailyPath;
  } else {
    const memPath = path.join(memDir, MEMORY_FILE);
    // Append to long-term memory
    const existing = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf-8') : '';
    fs.writeFileSync(memPath, existing + (existing ? '\n\n' : '') + content);
    return memPath;
  }
}

/**
 * Clean up old daily notes (keep last 7 days).
 * @param {string} cwd
 */
function cleanupOldNotes(cwd) {
  const memDir = path.join(cwd, MEMORY_DIR);
  if (!fs.existsSync(memDir)) return;

  const cutoff = Date.now() - 7 * 86400000;
  try {
    for (const f of fs.readdirSync(memDir)) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) {
        const date = new Date(f.replace('.md', '')).getTime();
        if (date < cutoff) {
          fs.unlinkSync(path.join(memDir, f));
        }
      }
    }
  } catch {}
}

module.exports = { loadMemory, saveMemory, cleanupOldNotes };
