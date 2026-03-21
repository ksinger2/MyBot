const fs = require('fs');
const path = require('path');

const JOURNAL_FILE = path.join('/home/node/.claude', 'session-journal.json');
const MAX_ENTRIES = 3;

function readJournal() {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return {};
    return JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8'));
  } catch { return {}; }
}

function writeJournal(data) {
  try {
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to write session journal:', err.message);
  }
}

/**
 * Append a completed session entry for a channel.
 * Keeps only the last MAX_ENTRIES entries.
 */
function appendEntry(channelId, { cwd, promptSummary, resultSummary, turnCount }) {
  const journal = readJournal();
  if (!journal[channelId]) journal[channelId] = [];

  journal[channelId].unshift({
    timestamp: new Date().toISOString(),
    cwd,
    promptSummary: (promptSummary || '').substring(0, 200),
    resultSummary: (resultSummary || '').substring(0, 400),
    turnCount: turnCount || 0,
  });

  // Keep only last MAX_ENTRIES
  journal[channelId] = journal[channelId].slice(0, MAX_ENTRIES);
  writeJournal(journal);
}

/**
 * Get formatted journal context string to prepend to a new session prompt.
 * Returns empty string if no history.
 */
function getJournalContext(channelId) {
  const journal = readJournal();
  const entries = journal[channelId];
  if (!entries || entries.length === 0) return '';

  const lines = entries.map((e, i) => {
    const label = i === 0 ? 'Last session' : `${i + 1} sessions ago`;
    const date = new Date(e.timestamp).toLocaleString();
    const parts = [`**${label}** (${date}, \`${e.cwd}\`)`];
    if (e.promptSummary) parts.push(`Asked: ${e.promptSummary}`);
    if (e.resultSummary) parts.push(`Result: ${e.resultSummary}`);
    if (e.turnCount) parts.push(`(${e.turnCount} turns)`);
    return parts.join(' — ');
  });

  return `[Session history — what happened in recent sessions]\n${lines.join('\n')}`;
}

module.exports = { appendEntry, getJournalContext };
