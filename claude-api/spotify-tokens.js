const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJsonSync } = require('./atomic-write');

// Tokens are encrypted at rest with AES-256-GCM (M6). The key is derived from
// the TOKEN_ENCRYPTION_KEY env var via HKDF-SHA256 so any-length secret works.
// If TOKEN_ENCRYPTION_KEY is not set, we fall back to plaintext and warn — this
// also preserves backward compat for any legacy plaintext entries already on
// disk (they parse normally and flow through `_decrypt` unchanged).

const TOKENS_FILE = path.join('/app/data', 'spotify-tokens.json');

const RAW_KEY = process.env.TOKEN_ENCRYPTION_KEY || '';
if (!RAW_KEY) {
  console.warn('[spotify-tokens] WARNING: TOKEN_ENCRYPTION_KEY not set — tokens will be stored in plain text. Set a 32-byte hex value in .env.');
}

// Derive a 32-byte key with HKDF (SHA-256) so an arbitrary-length env value still produces a usable key.
function _key() {
  if (!RAW_KEY) return null;
  return crypto.hkdfSync('sha256', Buffer.from(RAW_KEY, 'utf8'), Buffer.alloc(0), 'mybot-spotify-tokens', 32);
}

function _encrypt(plaintext) {
  const key = _key();
  if (!key) return plaintext; // pass-through if no key configured
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: tag.toString('hex'), ct: enc.toString('hex') });
}

function _decrypt(value) {
  if (typeof value !== 'string') return value;
  let env;
  try { env = JSON.parse(value); } catch { return value; }
  if (!env || env.v !== 1 || !env.iv || !env.tag || !env.ct) return value;
  const key = _key();
  if (!key) {
    console.warn('[spotify-tokens] encrypted token in store but TOKEN_ENCRYPTION_KEY not set — cannot decrypt');
    return null;
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(env.ct, 'hex')), decipher.final()]).toString('utf8');
  } catch (err) {
    console.warn(`[spotify-tokens] failed to decrypt: ${err.message}`);
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
  if (typeof entry === 'object') return entry;
  const plain = _decrypt(entry);
  if (plain == null) return null;
  if (typeof plain !== 'string') return plain;
  try { return JSON.parse(plain); } catch { return null; }
}

/**
 * Save Spotify OAuth tokens for a Discord user
 * @param {string} discordUserId
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number, spotifyUserId: string, displayName: string, email: string, isPremium: boolean }} tokenData
 */
function saveToken(discordUserId, { accessToken, refreshToken, expiresAt, spotifyUserId, displayName, email, isPremium }) {
  const store = readStore();
  const bundle = {
    accessToken,
    refreshToken,
    expiresAt,
    spotifyUserId,
    displayName,
    email,
    isPremium,
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
 * List all users who have connected their Spotify account
 * @returns {{ discordUserId: string, spotifyUserId: string, displayName: string, email: string, isPremium: boolean }[]}
 */
function listConnectedUsers() {
  const store = readStore();
  return Object.entries(store).map(([discordUserId, entry]) => {
    const data = _decodeEntry(entry) || {};
    return {
      discordUserId,
      spotifyUserId: data.spotifyUserId,
      displayName: data.displayName,
      email: data.email,
      isPremium: data.isPremium,
    };
  });
}

/**
 * Check if a Discord user has a connected Spotify account
 * @param {string} discordUserId
 * @returns {boolean}
 */
function isConnected(discordUserId) {
  return !!readStore()[discordUserId];
}

module.exports = { saveToken, getToken, removeToken, listConnectedUsers, isConnected };
