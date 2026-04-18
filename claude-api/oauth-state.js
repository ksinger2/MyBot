/**
 * Persistent OAuth state store — shared by google-auth.js and spotify-auth.js.
 *
 * Background: the OAuth `state` param is generated at `!setup` time and redeemed
 * when the provider redirects back to /auth/<provider>/callback. The round-trip
 * takes user-variable time (seconds to minutes) during which the bot container
 * may be rebuilt (e.g. operator pushes a fix). Holding the state table only in
 * process memory means any rebuild mid-flow kills every pending authorization —
 * users see "state not found or expired" even though they just clicked the link.
 *
 * Fix: serialize the (short-lived, tiny) state table to disk via atomic writes.
 * Survives rebuilds because /app/data is a named docker volume. TTL is still
 * enforced on read, so stale rows from crashed flows are ignored and eventually
 * swept.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJsonSync } = require('./atomic-write');

const STATE_FILE = path.join('/app/data', 'oauth-state.json');
const STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes — matches provider link TTLs
const STATE_MAP_CAP = 1000;

function _readStore() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return {}; }
}

function _writeStore(obj) {
  atomicWriteJsonSync(STATE_FILE, obj);
}

function _prune(store) {
  const now = Date.now();
  let changed = false;
  for (const [token, entry] of Object.entries(store)) {
    if (!entry || !entry.expiresAt || entry.expiresAt < now) {
      delete store[token];
      changed = true;
    }
  }
  // Enforce cap — evict oldest by expiresAt
  const entries = Object.entries(store);
  if (entries.length > STATE_MAP_CAP) {
    entries.sort((a, b) => (a[1].expiresAt || 0) - (b[1].expiresAt || 0));
    const excess = entries.length - STATE_MAP_CAP;
    for (let i = 0; i < excess; i++) delete store[entries[i][0]];
    changed = true;
  }
  return changed;
}

/**
 * Store a new state token for an OAuth flow.
 * @param {string} userId - opaque caller ID (Discord snowflake or Signal phone)
 * @param {string} provider - 'google' | 'spotify' | etc.
 * @returns {string} the 48-char hex state token to embed in the OAuth URL
 */
function putState(userId, provider) {
  const stateToken = crypto.randomBytes(24).toString('hex');
  const store = _readStore();
  _prune(store);
  store[stateToken] = {
    userId,
    provider,
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  _writeStore(store);
  return stateToken;
}

/**
 * Consume and return the state entry (one-time use). Returns null if missing,
 * expired, or provider mismatch.
 * @param {string} stateToken
 * @param {string} expectedProvider
 * @returns {{ userId: string, provider: string, expiresAt: number } | null}
 */
function takeState(stateToken, expectedProvider) {
  const store = _readStore();
  const entry = store[stateToken];
  if (!entry) return null;
  delete store[stateToken];
  _writeStore(store);
  if (entry.expiresAt < Date.now()) return null;
  if (expectedProvider && entry.provider !== expectedProvider) return null;
  return entry;
}

// Periodic sweep of expired rows. Guarded against double-registration when the
// module is required from multiple paths.
if (!global.__mybot_oauth_state_sweeper) {
  global.__mybot_oauth_state_sweeper = true;
  setInterval(() => {
    try {
      const store = _readStore();
      if (_prune(store)) _writeStore(store);
    } catch {}
  }, 5 * 60 * 1000).unref?.();
}

module.exports = { putState, takeState };
