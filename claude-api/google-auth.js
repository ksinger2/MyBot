const { google } = require('googleapis');
const userTokens = require('./user-tokens');
const oauthState = require('./oauth-state');

const BOT_CALENDAR_KEY = '__bot_calendar__';

// Requires env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// The redirect URI should match what's configured in Google Cloud Console.
// For the bot's internal Express server, this would be something like:
//   http://localhost:3400/auth/google/callback  (dev)
//   https://yourdomain.com/auth/google/callback (prod)

// OAuth state is now persisted to disk in oauth-state.js so a rebuild between
// `!setup` and the provider redirect does not invalidate pending authorizations.
// (Previously an in-memory Map — see git history for the M6 hardening rationale.)

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
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
  const stateToken = oauthState.putState(discordUserId, 'google');
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
  const entry = oauthState.takeState(state, 'google');
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

  // Normalize: if userId is a UUID, also resolve to phone via UUID map so the
  // token is findable by phone lookup (profiles are keyed by phone).
  let tokenKey = discordUserId;
  let phoneForProfile = discordUserId; // may be phone or UUID
  try {
    if (!discordUserId.startsWith('+')) {
      // UUID — try to resolve to phone
      const { readEncryptedJson } = require('./encrypted-json');
      const uuidMap = readEncryptedJson('/app/data/signal-uuid-phone.json', 'mybot-signal-uuid-phone');
      if (uuidMap?.version === 2 && uuidMap.byUuid?.[discordUserId]?.phone) {
        phoneForProfile = uuidMap.byUuid[discordUserId].phone;
        // Save under BOTH keys so either lookup works
        tokenKey = phoneForProfile;
      }
    }
  } catch {}

  userTokens.saveToken(tokenKey, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date,
    email,
    displayName,
  });
  // Also save under original key if different, so existing references still work
  if (tokenKey !== discordUserId) {
    userTokens.saveToken(discordUserId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date,
      email,
      displayName,
    });
  }

  // Update the user's profile with calendar connection status
  try {
    const userProfiles = require('./user-profiles');
    userProfiles.markCalendarConnected(phoneForProfile, email);
  } catch {}

  return { userId: discordUserId, email, displayName };
}

// Lazy-load the UUID map for cross-referencing phone↔UUID token lookups.
function _getUuidMap() {
  try {
    const { readEncryptedJson } = require('./encrypted-json');
    const map = readEncryptedJson('/app/data/signal-uuid-phone.json', 'mybot-signal-uuid-phone');
    return (map?.version === 2) ? map : null;
  } catch { return null; }
}

/**
 * Check if a user's token is expired and refresh it if needed.
 * @param {string} discordUserId
 * @returns {Promise<boolean>} true if token is valid (or was refreshed), false if no token
 */
async function refreshTokenIfNeeded(discordUserId) {
  const tokenData = userTokens.getTokenForSignalUser(discordUserId, _getUuidMap());
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

  const tokenData = userTokens.getTokenForSignalUser(discordUserId, _getUuidMap());
  if (!tokenData) return null;

  const client = getOAuth2Client();
  client.setCredentials({
    access_token: tokenData.accessToken,
    refresh_token: tokenData.refreshToken,
  });

  return google.calendar({ version: 'v3', auth: client });
}

/**
 * Get an authenticated Gmail API client for a specific user.
 * Automatically refreshes the token if needed.
 * @param {string} userId
 * @returns {Promise<object|null>} googleapis gmail client, or null if user not connected
 */
async function getGmailClient(userId) {
  const valid = await refreshTokenIfNeeded(userId);
  if (!valid) return null;

  const tokenData = userTokens.getTokenForSignalUser(userId, _getUuidMap());
  if (!tokenData) return null;

  const client = getOAuth2Client();
  client.setCredentials({
    access_token: tokenData.accessToken,
    refresh_token: tokenData.refreshToken,
  });

  return google.gmail({ version: 'v1', auth: client });
}

/**
 * Get the bot's own calendar client (for centralized event scheduling).
 * Returns null if bot calendar account is not connected.
 */
async function getBotCalendarClient() {
  return getCalendarClient(BOT_CALENDAR_KEY);
}

/**
 * Get the bot's own Gmail client (for sending emails from the bot's account).
 * Returns null if bot account is not connected.
 */
async function getBotGmailClient() {
  return getGmailClient(BOT_CALENDAR_KEY);
}

/**
 * Get the bot calendar account's email, or null if not connected.
 */
function getBotCalendarEmail() {
  const tokenData = userTokens.getToken(BOT_CALENDAR_KEY);
  return tokenData?.email || null;
}

module.exports = { getAuthUrl, handleCallback, getCalendarClient, getGmailClient, refreshTokenIfNeeded, getBotCalendarClient, getBotGmailClient, getBotCalendarEmail, BOT_CALENDAR_KEY };
