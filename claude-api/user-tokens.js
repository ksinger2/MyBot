const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJsonSync } = require('./atomic-write');

// Tokens are encrypted at rest with AES-256-GCM (M6). The key is derived from
// the TOKEN_ENCRYPTION_KEY env var via HKDF-SHA256 so any-length secret works.
// If TOKEN_ENCRYPTION_KEY is not set, we fall back to plaintext and warn — this
// also preserves backward compat for any legacy plaintext entries already on
// disk (they parse normally and flow through `_decrypt` unchanged).

const TOKENS_FILE = path.join('/app/data', 'user-tokens.json');

const RAW_KEY = process.env.TOKEN_ENCRYPTION_KEY || '';
if (!RAW_KEY) {
  console.warn('[user-tokens] WARNING: TOKEN_ENCRYPTION_KEY not set — tokens will be stored in plain text. Set a 32-byte hex value in .env.');
}

// Derive a 32-byte key with HKDF (SHA-256) so an arbitrary-length env value still produces a usable key.
function _key() {
  if (!RAW_KEY) return null;
  return crypto.hkdfSync('sha256', Buffer.from(RAW_KEY, 'utf8'), Buffer.alloc(0), 'mybot-user-tokens', 32);
}

function _encrypt(plaintext) {
  const key = _key();
  if (!key) return plaintext; // pass-through if no key configured
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // envelope: { v: 1, iv: hex, tag: hex, ct: hex }
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: tag.toString('hex'), ct: enc.toString('hex') });
}

function _decrypt(value) {
  // Backward compat: if this isn't an envelope (e.g. legacy plain string), return it as-is
  if (typeof value !== 'string') return value;
  let env;
  try { env = JSON.parse(value); } catch { return value; }
  if (!env || env.v !== 1 || !env.iv || !env.tag || !env.ct) return value;
  const key = _key();
  if (!key) {
    console.warn('[user-tokens] encrypted token in store but TOKEN_ENCRYPTION_KEY not set — cannot decrypt');
    return null;
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(env.ct, 'hex')), decipher.final()]).toString('utf8');
  } catch (err) {
    console.warn(`[user-tokens] failed to decrypt: ${err.message}`);
    return null;
  }
}

function readStore() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch { return {}; }
}

function writeStore(store) {
  atomicWriteJsonSync(TOKENS_FILE, store);
}

// Decode a stored entry back into a token-bundle object. Handles:
//   - legacy plain object entries (pre-encryption)
//   - encrypted-envelope string entries (new format)
function _decodeEntry(entry) {
  if (!entry) return null;
  // Legacy: already a plain object on disk — return as-is.
  if (typeof entry === 'object') return entry;
  // New: encrypted (or pass-through) string — decrypt then parse.
  const plain = _decrypt(entry);
  if (plain == null) return null;
  if (typeof plain !== 'string') return plain;
  try { return JSON.parse(plain); } catch { return null; }
}

/**
 * Save OAuth tokens for a Discord user
 * @param {string} discordUserId
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number, email: string, displayName: string }} tokenData
 */
function saveToken(discordUserId, { accessToken, refreshToken, expiresAt, email, displayName }) {
  const store = readStore();
  const bundle = {
    accessToken,
    refreshToken,
    expiresAt,
    email,
    displayName,
    connectedAt: new Date().toISOString(),
  };
  store[discordUserId] = _encrypt(JSON.stringify(bundle));
  writeStore(store);
}

/**
 * Get stored token data for a Discord user
 * @param {string} discordUserId
 * @returns {object|null} token data or null if not connected
 */
function getToken(discordUserId) {
  const store = readStore();
  if (!(discordUserId in store)) return null;
  return _decodeEntry(store[discordUserId]);
}

/**
 * Remove a user's stored tokens (disconnect)
 * @param {string} discordUserId
 */
function removeToken(discordUserId) {
  const store = readStore();
  if (!store[discordUserId]) return false;
  delete store[discordUserId];
  writeStore(store);
  return true;
}

/**
 * List all users who have connected their Google account
 * @returns {{ discordUserId: string, email: string, displayName: string }[]}
 */
function listConnectedUsers() {
  const store = readStore();
  return Object.entries(store).map(([discordUserId, entry]) => {
    const data = _decodeEntry(entry) || {};
    return {
      discordUserId,
      email: data.email,
      displayName: data.displayName,
    };
  });
}

/**
 * Check if a user has a connected Google account (tries alternate IDs via UUID map).
 * @param {string} discordUserId - phone number or UUID
 * @returns {boolean}
 */
function isConnected(discordUserId) {
  const store = readStore();
  if (store[discordUserId]) return true;
  // Cross-reference via UUID map
  const map = _loadUuidMap();
  if (!map) return false;
  if (discordUserId.startsWith('+')) {
    const uuids = map.byPhone?.[discordUserId] || [];
    return uuids.some(uuid => !!store[uuid]);
  } else {
    const phone = map.byUuid?.[discordUserId]?.phone;
    return phone ? !!store[phone] : false;
  }
}

// Lazy-load UUID map from disk for cross-referencing phone↔UUID token lookups.
function _loadUuidMap() {
  try {
    const { readEncryptedJson } = require('./encrypted-json');
    const map = readEncryptedJson('/app/data/signal-uuid-phone.json', 'mybot-signal-uuid-phone');
    return (map?.version === 2) ? map : null;
  } catch { return null; }
}

/**
 * Look up a token by Signal identifier (phone or UUID), trying alternate IDs
 * via the UUID map. This fixes the mismatch where tokens may be stored under
 * a UUID but looked up by phone (or vice versa).
 * @param {string} identifier - phone number or UUID
 * @param {{ byUuid?: Object, byPhone?: Object }} [uuidMap] - optional pre-loaded UUID map (loads from disk if omitted)
 * @returns {object|null} token data or null if not connected
 */
function getTokenForSignalUser(identifier, uuidMap) {
  // Try direct lookup first
  const direct = getToken(identifier);
  if (direct) return direct;

  // Load UUID map if not provided
  const map = uuidMap || _loadUuidMap();
  if (!map) return null;

  if (identifier.startsWith('+')) {
    // identifier is a phone — try associated UUIDs
    const uuids = map.byPhone?.[identifier] || [];
    for (const uuid of uuids) {
      const token = getToken(uuid);
      if (token) return token;
    }
  } else {
    // identifier is a UUID — try the mapped phone
    const entry = map.byUuid?.[identifier];
    if (entry?.phone) {
      const token = getToken(entry.phone);
      if (token) return token;
    }
  }

  return null;
}

module.exports = { saveToken, getToken, removeToken, listConnectedUsers, isConnected, getTokenForSignalUser };
