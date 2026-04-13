const crypto = require('crypto');
const { google } = require('googleapis');
const userTokens = require('./user-tokens');

// Requires env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// The redirect URI should match what's configured in Google Cloud Console.
// For the bot's internal Express server, this would be something like:
//   http://localhost:3400/auth/google/callback  (dev)
//   https://yourdomain.com/auth/google/callback (prod)

// ---------------------------------------------------------------------------
// OAuth state map (M6 hardening) — random server-side tokens mapped to userId.
// The state param sent to Google is no longer the userId; it's an unguessable
// 48-hex-char token that we look up on callback. This prevents a CSRF-style
// link hijack from matching a callback to the wrong user.
// ---------------------------------------------------------------------------
const STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const _stateMap = new Map();

// F3/F14: hard-cap _stateMap at 1000 entries. Evict oldest (FIFO) on overflow.
const _STATE_MAP_CAP = 1000;
let _stateMapLastEvictWarn = 0;

function _putState(userId) {
  const stateToken = crypto.randomBytes(24).toString('hex');
  _stateMap.set(stateToken, {
    userId,
    provider: 'google',
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  // F3/F14: enforce cap
  if (_stateMap.size > _STATE_MAP_CAP) {
    const excess = _stateMap.size - _STATE_MAP_CAP;
    const iter = _stateMap.keys();
    for (let i = 0; i < excess; i++) {
      _stateMap.delete(iter.next().value);
    }
    const now = Date.now();
    if (now - _stateMapLastEvictWarn > 60000) {
      _stateMapLastEvictWarn = now;
      console.warn(`[google-auth] _stateMap overflow — evicted ${excess} oldest entries (cap: ${_STATE_MAP_CAP})`);
    }
  }
  return stateToken;
}

function _takeState(stateToken) {
  const entry = _stateMap.get(stateToken);
  if (!entry) return null;
  _stateMap.delete(stateToken); // one-time use
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// Guard against double-register if the module is imported more than once.
if (!global.__mybot_google_state_sweeper) {
  global.__mybot_google_state_sweeper = true;
  setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of _stateMap.entries()) {
      if (entry.expiresAt < now) _stateMap.delete(token);
    }
  }, 5 * 60 * 1000).unref?.();
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.BOT_PUBLIC_URL || 'http://localhost:3400'}/auth/google/callback`;

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

/**
 * Generate a Google OAuth URL for a Discord user to authorize the bot.
 * The Discord user ID is encoded in the state param so we can associate
 * the tokens with the correct user on callback.
 * @param {string} discordUserId
 * @returns {string} authorization URL
 */
function getAuthUrl(discordUserId) {
  const client = getOAuth2Client();
  const stateToken = _putState(discordUserId);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: stateToken,
  });
}

/**
 * Exchange an authorization code for tokens and persist them.
 * @param {string} code - authorization code from Google
 * @param {string} state - Discord user ID passed through the OAuth state param
 * @returns {Promise<{ email: string, displayName: string }>}
 */
async function handleCallback(code, state) {
  const entry = _takeState(state);
  if (!entry) {
    throw new Error('OAuth state not found or expired — please restart the connect flow');
  }
  const discordUserId = entry.userId;
  const client = getOAuth2Client();

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Fetch user profile info so we can store a friendly display name
  const people = google.people({ version: 'v1', auth: client });
  const profile = await people.people.get({
    resourceName: 'people/me',
    personFields: 'names,emailAddresses',
  });

  const email = profile.data.emailAddresses?.[0]?.value || 'unknown';
  const displayName = profile.data.names?.[0]?.displayName || email;

  userTokens.saveToken(discordUserId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date,
    email,
    displayName,
  });

  // If this is a Signal user (phone number), update their profile too
  try {
    const userProfiles = require('./user-profiles');
    userProfiles.markCalendarConnected(discordUserId, email);
  } catch {}

  return { userId: discordUserId, email, displayName };
}

/**
 * Check if a user's token is expired and refresh it if needed.
 * @param {string} discordUserId
 * @returns {Promise<boolean>} true if token is valid (or was refreshed), false if no token
 */
async function refreshTokenIfNeeded(discordUserId) {
  const tokenData = userTokens.getToken(discordUserId);
  if (!tokenData) return false;

  // Refresh if within 5 minutes of expiry
  const bufferMs = 5 * 60 * 1000;
  if (tokenData.expiresAt && Date.now() < tokenData.expiresAt - bufferMs) {
    return true; // still valid
  }

  const client = getOAuth2Client();
  client.setCredentials({
    access_token: tokenData.accessToken,
    refresh_token: tokenData.refreshToken,
  });

  try {
    const { credentials } = await client.refreshAccessToken();
    userTokens.saveToken(discordUserId, {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token || tokenData.refreshToken,
      expiresAt: credentials.expiry_date,
      email: tokenData.email,
      displayName: tokenData.displayName,
    });
    return true;
  } catch (err) {
    console.error(`[google-auth] Failed to refresh token for user ${discordUserId}:`, err.message);
    return false;
  }
}

/**
 * Get an authenticated Google Calendar API client for a specific Discord user.
 * Automatically refreshes the token if needed.
 * @param {string} discordUserId
 * @returns {Promise<object|null>} googleapis calendar client, or null if user not connected
 */
async function getCalendarClient(discordUserId) {
  const valid = await refreshTokenIfNeeded(discordUserId);
  if (!valid) return null;

  const tokenData = userTokens.getToken(discordUserId);
  if (!tokenData) return null;

  const client = getOAuth2Client();
  client.setCredentials({
    access_token: tokenData.accessToken,
    refresh_token: tokenData.refreshToken,
  });

  return google.calendar({ version: 'v3', auth: client });
}

module.exports = { getAuthUrl, handleCallback, getCalendarClient, refreshTokenIfNeeded };
