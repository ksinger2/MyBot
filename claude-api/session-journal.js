const fs = require('fs');
const path = require('path');

const JOURNAL_FILE = path.join('/home/node/.claude', 'session-journal.json');
const MAX_ENTRIES = 5;

function _timeAgo(isoString) {
  const ms = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function readJournal() {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return {};
    return JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8'));
  } catch { return {}; }
}

function writeJournal(data) {
  const tmpFile = JOURNAL_FILE + '.tmp';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
      fs.renameSync(tmpFile, JOURNAL_FILE);
      return;
    } catch (err) {
      console.error(`Session journal write attempt ${attempt + 1}/3 failed:`, err.message);
      if (attempt < 2) {
        // Brief synchronous delay before retry
        const start = Date.now();
        while (Date.now() - start < [100, 500][attempt]) {}
      } else {
        // Final failure — try to alert
        try {
          const { sendErrorAlert } = require('./error-alerting');
          sendErrorAlert(err, { source: 'session-journal', detail: 'Journal write failed 3x' });
        } catch {}
      }
    }
  }
}

/**
 * Append a completed session entry for a channel.
 * Keeps only the last MAX_ENTRIES entries.
 */
function appendEntry(channelId, { cwd, resultSummary, turnCount }) {
  const journal = readJournal();
  if (!journal[channelId]) journal[channelId] = [];

  // Security: only store metadata, never user prompts or response content.
  // Conversation content was previously stored as promptSummary/resultSummary
  // which leaked sensitive data (phone numbers, secrets, private conversations)
  // to the plaintext journal file on disk.
  journal[channelId].unshift({
    timestamp: new Date().toISOString(),
    cwd,
    turnCount: turnCount || 0,
    resultLength: (resultSummary || '').length,
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
    const ago = _timeAgo(e.timestamp);
    const parts = [`**${label}** (${ago}, \`${e.cwd}\`)`];
    if (e.turnCount) parts.push(`${e.turnCount} turns`);
    if (e.resultLength) parts.push(`~${e.resultLength} chars`);
    return parts.join(' — ');
  });

  return `[Session history — metadata only, no content]\n${lines.join('\n')}`;
}

module.exports = { appendEntry, getJournalContext };
