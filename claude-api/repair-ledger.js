/**
 * repair-ledger.js — Persistent log of self-repair attempts
 *
 * Tracks what Bianca tried to fix, whether it worked, and what the user said.
 * Injected into Bianca's context when she's working on herself (/workspace/MyBot)
 * so she doesn't repeat failed approaches or ignore previous feedback.
 *
 * Persisted to /home/node/.claude/repair-ledger.json (survives rebuilds).
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

const LEDGER_FILE = path.join('/home/node/.claude', 'repair-ledger.json');
const MAX_ENTRIES = 50;

function _load() {
  try {
    if (fs.existsSync(LEDGER_FILE)) return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch {}
  return [];
}

function _save(entries) {
  try { atomicWriteJsonSync(LEDGER_FILE, entries); } catch (e) {
    console.error(`[repair-ledger] save failed: ${e.message}`);
  }
}

/**
 * Record a new repair attempt.
 * @param {object} entry
 * @param {string} entry.issue - What's broken (user's complaint)
 * @param {string} entry.approach - What was tried to fix it
 * @param {string[]} entry.filesChanged - Files modified
 * @param {string|null} entry.commitHash - Commit hash if committed
 * @returns {number} The new entry's ID
 */
function addAttempt({ issue, approach, filesChanged = [], commitHash = null }) {
  const entries = _load();
  const id = entries.length > 0 ? Math.max(...entries.map(e => e.id)) + 1 : 1;
  entries.push({
    id,
    issue: (issue || '').substring(0, 300),
    approach: (approach || '').substring(0, 500),
    filesChanged,
    commitHash,
    smokeTestResult: 'pending',
    userVerdict: null,
    timestamp: new Date().toISOString(),
  });
  // Trim to MAX_ENTRIES
  while (entries.length > MAX_ENTRIES) entries.shift();
  _save(entries);
  console.log(`[repair-ledger] Added attempt #${id}: ${issue?.substring(0, 60)}`);
  return id;
}

/**
 * Mark the latest repair attempt as failed (user reported it's still broken).
 */
function markLatestFailed(feedback) {
  const entries = _load();
  if (entries.length === 0) return;
  const latest = entries[entries.length - 1];
  latest.userVerdict = 'fail';
  latest.userFeedback = (feedback || '').substring(0, 300);
  _save(entries);
  console.log(`[repair-ledger] Marked attempt #${latest.id} as FAILED: ${feedback?.substring(0, 60)}`);
}

/**
 * Mark the latest repair attempt's smoke test result.
 */
function markSmokeTest(id, result) {
  const entries = _load();
  const entry = entries.find(e => e.id === id);
  if (entry) {
    entry.smokeTestResult = result;
    _save(entries);
  }
}

/**
 * Get recent repair attempts for a given issue keyword (for context injection).
 * Returns entries whose issue field matches any of the keywords.
 */
function getRecentForIssue(keywords, limit = 10) {
  const entries = _load();
  if (!keywords || keywords.length === 0) return entries.slice(-limit);
  const kw = Array.isArray(keywords) ? keywords : [keywords];
  const lower = kw.map(k => k.toLowerCase());
  return entries
    .filter(e => lower.some(k => e.issue.toLowerCase().includes(k)))
    .slice(-limit);
}

/**
 * Get all recent entries (for full context dump).
 */
function getRecent(limit = 15) {
  return _load().slice(-limit);
}

/**
 * Build a context block for injection into Bianca's system prompt when
 * she's working on self-repair.
 */
function buildRepairContext() {
  const recent = getRecent(10);
  if (recent.length === 0) return null;

  const lines = recent.map(e => {
    const verdict = e.userVerdict === 'fail' ? ' [USER SAID: STILL BROKEN]'
      : e.smokeTestResult === 'fail' ? ' [SMOKE TEST FAILED]'
      : e.smokeTestResult === 'pass' ? ' [VERIFIED]'
      : '';
    return `- #${e.id} (${e.timestamp.substring(0, 10)}): "${e.issue}" → ${e.approach}${verdict}`;
  });

  return `[REPAIR LEDGER — Previous self-repair attempts. Do NOT repeat approaches marked STILL BROKEN or FAILED.]\n${lines.join('\n')}`;
}

/**
 * Detect "still broken" feedback in user messages.
 * Returns true if the message likely indicates a failed repair.
 */
function isFailureFeedback(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const patterns = [
    'still broken', 'still not working', 'still doesn\'t work', 'still doesnt work',
    'didn\'t fix', 'didnt fix', 'not fixed', 'hasn\'t fixed', 'hasnt fixed',
    'same problem', 'same issue', 'same bug', 'still happening',
    'that didn\'t work', 'that didnt work', 'nothing changed',
    'you said you fixed', 'told me it was fixed', 'claimed you fixed',
  ];
  return patterns.some(p => lower.includes(p));
}

module.exports = {
  addAttempt,
  markLatestFailed,
  markSmokeTest,
  getRecentForIssue,
  getRecent,
  buildRepairContext,
  isFailureFeedback,
};
