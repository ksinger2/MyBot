/**
 * user-prefs.js — Deterministic per-user preference store.
 *
 * The LLM never "remembers" preferences. Instead, when a user says
 * "remember that study events should be Tomato colored", the system prompt
 * tells Claude to emit a [SET_PREF: ...] tag, which is intercepted in bot.js
 * and persisted here. Later, when an [EVENT: ...] tag fires, the handler
 * calls matchEventPrefs() to apply any matching rules BEFORE calling the
 * Google Calendar API. Keyword-only matching — no fuzzy, no LLM.
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

const PREFS_FILE = path.join('/app/data', 'user-prefs.json');

// Google Calendar color name → colorId mapping (event colors only).
const GCAL_COLOR_IDS = {
  tomato: '11', flamingo: '4', tangerine: '6', banana: '5',
  sage: '2', basil: '10', peacock: '7', blueberry: '9',
  lavender: '1', grape: '3', graphite: '8',
};

function _load() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; }
}

function _save(data) {
  atomicWriteJsonSync(PREFS_FILE, data);
}

// Save a preference rule for a user.
// domain: 'events' (only domain for now)
// rule: { match: ['study', 'exam'], color: 'Tomato', duration_minutes: 60, reminder_minutes: 15 }
function setPref(userId, domain, rule) {
  const data = _load();
  if (!data[userId]) data[userId] = {};
  if (!data[userId][domain]) data[userId][domain] = [];
  // Replace existing rule with same match keywords, or append.
  const matchKey = (rule.match || []).slice().sort().join(',');
  const idx = data[userId][domain].findIndex(r => (r.match || []).slice().sort().join(',') === matchKey);
  if (idx >= 0) data[userId][domain][idx] = rule;
  else data[userId][domain].push(rule);
  _save(data);
}

// Get all rules for a user + domain.
function getPrefs(userId, domain) {
  const data = _load();
  return data[userId]?.[domain] || [];
}

// Match event title against user's event rules. Returns merged overrides.
// { color: 'Tomato', colorId: '11', duration_minutes: 60, reminder_minutes: 15 }
function matchEventPrefs(userId, title) {
  const rules = getPrefs(userId, 'events');
  const lowerTitle = (title || '').toLowerCase();
  const result = {};
  for (const rule of rules) {
    const keywords = rule.match || [];
    if (keywords.some(kw => lowerTitle.includes(kw.toLowerCase()))) {
      if (rule.color) {
        result.color = rule.color;
        result.colorId = GCAL_COLOR_IDS[rule.color.toLowerCase()] || null;
      }
      if (rule.duration_minutes) result.duration_minutes = rule.duration_minutes;
      if (rule.reminder_minutes != null) result.reminder_minutes = rule.reminder_minutes;
    }
  }
  return result;
}

// Parse a [SET_PREF: ...] tag string into a structured rule.
// Input: 'domain="events" match="study,exam" color="Tomato" duration_minutes=60'
// Output: { domain: 'events', rule: { match: ['study','exam'], color: 'Tomato', duration_minutes: 60 } }
function parseSetPrefTag(raw) {
  const params = {};
  raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
  raw.replace(/(\w+)=(\d+)/g, (_, k, v) => { params[k] = parseInt(v, 10); });
  const domain = params.domain || 'events';
  const rule = {};
  if (params.match) rule.match = String(params.match).split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  if (params.color) rule.color = params.color;
  if (params.duration_minutes) rule.duration_minutes = params.duration_minutes;
  if (params.reminder_minutes != null) rule.reminder_minutes = params.reminder_minutes;
  return { domain, rule };
}

module.exports = { setPref, getPrefs, matchEventPrefs, parseSetPrefTag, GCAL_COLOR_IDS };
