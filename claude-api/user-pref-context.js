/**
 * user-pref-context.js — Formats user preferences for context injection.
 *
 * Preferences are injected into the first human message (NOT the system prompt)
 * to keep the system prompt small and cacheable. Output is compact and
 * human-readable — every token counts in the context window.
 */
const { getPrefs } = require('./user-prefs');

const DOMAINS = ['events', 'email', 'shopping', 'notifications'];

// Keys that are structural, not display-worthy.
const SKIP_KEYS = new Set(['match']);

/**
 * Format a single rule's non-match fields into a compact readable string.
 * { color: 'Tomato', duration_minutes: 60, reminder_minutes: 15 }
 * → "Tomato, 60min, 15min reminder"
 */
function _formatFields(rule) {
  const parts = [];
  for (const [key, value] of Object.entries(rule)) {
    if (SKIP_KEYS.has(key)) continue;
    // Pretty-print common field patterns
    if (key === 'color') {
      parts.push(String(value));
    } else if (key === 'duration_minutes') {
      parts.push(`${value}min`);
    } else if (key === 'reminder_minutes') {
      parts.push(`${value}min reminder`);
    } else if (key === 'tone') {
      parts.push(`${value} tone`);
    } else if (typeof value === 'boolean') {
      // always_draft: true → "always draft"
      parts.push(value ? key.replace(/_/g, ' ') : `no ${key.replace(/_/g, ' ')}`);
    } else {
      // Generic: "prefer Dove", "avoid aluminum"
      parts.push(`${key.replace(/_/g, ' ')} ${value}`);
    }
  }
  return parts.join(', ');
}

/**
 * Format all rules for a domain into a single line.
 * Returns null if no rules exist.
 *
 * Example output:
 *   "Events: study/exam → Tomato, 60min, 15min reminder; meeting → Peacock, 30min"
 */
function _formatDomain(userId, domain) {
  const rules = getPrefs(userId, domain);
  if (!rules.length) return null;

  const label = domain.charAt(0).toUpperCase() + domain.slice(1);
  const segments = rules.map(rule => {
    const matchStr = (rule.match || []).join('/');
    const fields = _formatFields(rule);
    if (matchStr && fields) return `${matchStr} → ${fields}`;
    if (matchStr) return matchStr;
    return fields;
  }).filter(Boolean);

  if (!segments.length) return null;
  return `${label}: ${segments.join('; ')}`;
}

/**
 * Build a compact preference context block for a user.
 * Returns empty string if user has no preferences in any domain.
 */
function buildPrefContext(userId) {
  const lines = [];
  for (const domain of DOMAINS) {
    const line = _formatDomain(userId, domain);
    if (line) lines.push(line);
  }
  if (!lines.length) return '';
  return `[User Preferences]\n${lines.join('\n')}`;
}

module.exports = { buildPrefContext };
