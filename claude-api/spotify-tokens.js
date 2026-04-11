const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

// NOTE: In production, tokens should be encrypted at rest (e.g. via AES-256-GCM
// with a key from a secrets manager). This module stores them as plaintext JSON
// for development convenience only.

const TOKENS_FILE = path.join('/app/data', 'spotify-tokens.json');

function readStore() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch { return {}; }
}

function writeStore(store) {
  atomicWriteJsonSync(TOKENS_FILE, store);
}

/**
 * Save Spotify OAuth tokens for a Discord user
 * @param {string} discordUserId
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number, spotifyUserId: string, displayName: string, email: string, isPremium: boolean }} tokenData
 */
function saveToken(discordUserId, { accessToken, refreshToken, expiresAt, spotifyUserId, displayName, email, isPremium }) {
  const store = readStore();
  store[discordUserId] = {
    accessToken,
    refreshToken,
    expiresAt,
    spotifyUserId,
    displayName,
    email,
    isPremium,
    connectedAt: new Date().toISOString(),
  };
  writeStore(store);
}

/**
 * Get stored token data for a Discord user
 * @param {string} discordUserId
 * @returns {object|null} token data or null if not connected
 */
function getToken(discordUserId) {
  const store = readStore();
  return store[discordUserId] || null;
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
  return Object.entries(store).map(([discordUserId, data]) => ({
    discordUserId,
    spotifyUserId: data.spotifyUserId,
    displayName: data.displayName,
    email: data.email,
    isPremium: data.isPremium,
  }));
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
