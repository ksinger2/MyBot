const crypto = require('crypto');
const spotifyTokens = require('./spotify-tokens');

// Requires env vars: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
// Optional: SPOTIFY_REDIRECT_URI (defaults to http://localhost:3400/auth/spotify/callback)

// ---------------------------------------------------------------------------
// OAuth state map (M6 hardening) — random server-side tokens mapped to userId.
// The state param sent to Spotify is no longer the userId; it's an unguessable
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
    provider: 'spotify',
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
      console.warn(`[spotify-auth] _stateMap overflow — evicted ${excess} oldest entries (cap: ${_STATE_MAP_CAP})`);
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
if (!global.__mybot_spotify_state_sweeper) {
  global.__mybot_spotify_state_sweeper = true;
  setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of _stateMap.entries()) {
      if (entry.expiresAt < now) _stateMap.delete(token);
    }
  }, 5 * 60 * 1000).unref?.();
}

const SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
  'playlist-read-private',
  'user-read-private',
  'user-read-email',
  'user-top-read',
  'user-library-read',
];

const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `${process.env.BOT_PUBLIC_URL || 'http://localhost:3400'}/auth/spotify/callback`;

/**
 * Generate a Spotify OAuth URL for a Discord user to authorize the bot.
 * The Discord user ID is encoded in the state param so we can associate
 * the tokens with the correct user on callback.
 * @param {string} discordUserId
 * @returns {string} authorization URL
 */
function getAuthUrl(discordUserId) {
  const stateToken = _putState(discordUserId);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: SCOPES.join(' '),
    redirect_uri: REDIRECT_URI,
    state: stateToken,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens and persist them.
 * @param {string} code - authorization code from Spotify
 * @param {string} state - Discord user ID passed through the OAuth state param
 * @returns {Promise<{ displayName: string, email: string, spotifyUserId: string, isPremium: boolean }>}
 */
async function handleCallback(code, state) {
  const entry = _takeState(state);
  if (!entry) {
    throw new Error('OAuth state not found or expired — please restart the connect flow');
  }
  const discordUserId = entry.userId;

  // Exchange code for tokens
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
      ).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Spotify token exchange failed: ${err}`);
  }

  const tokens = await tokenRes.json();

  // Fetch user profile
  const profile = await spotifyApi(tokens.access_token, 'GET', 'me');

  const displayName = profile.display_name || profile.id;
  const email = profile.email || 'unknown';
  const spotifyUserId = profile.id;
  const isPremium = profile.product === 'premium';

  spotifyTokens.saveToken(discordUserId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    spotifyUserId,
    displayName,
    email,
    isPremium,
  });

  // Mark profile as Spotify-connected and auto-import top artists as tags
  try {
    const userProfiles = require('./user-profiles');
    userProfiles.setProfile(discordUserId, { spotify_connected: true, spotify_email: email, spotify_user_id: spotifyUserId });
    // Fetch top artists and add as tags (best-effort)
    const topArtists = await spotifyApi(tokens.access_token, 'GET', 'me/top/artists?time_range=medium_term&limit=20');
    if (topArtists.items && topArtists.items.length > 0) {
      let imported = 0;
      for (const artist of topArtists.items) {
        const tag = userProfiles.addTag(discordUserId, artist.name, 'Artist');
        if (tag) imported++;
      }
      console.log(`[spotify] Auto-imported ${imported} artist tag(s) for user`);
    }
  } catch (err) {
    console.warn(`[spotify] Could not auto-tag artists: ${err.message}`);
  }

  return { userId: discordUserId, displayName, email, spotifyUserId, isPremium };
}

/**
 * Check if a user's token is expired and refresh it if needed.
 * Uses a 5-minute buffer before actual expiry.
 * @param {string} discordUserId
 * @returns {Promise<boolean>} true if token is valid (or was refreshed), false if no token
 */
async function refreshTokenIfNeeded(discordUserId) {
  const tokenData = spotifyTokens.getToken(discordUserId);
  if (!tokenData) return false;

  // Refresh if within 5 minutes of expiry
  const bufferMs = 5 * 60 * 1000;
  if (tokenData.expiresAt && Date.now() < tokenData.expiresAt - bufferMs) {
    return true; // still valid
  }

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenData.refreshToken,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(err);
    }

    const tokens = await tokenRes.json();

    spotifyTokens.saveToken(discordUserId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || tokenData.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      spotifyUserId: tokenData.spotifyUserId,
      displayName: tokenData.displayName,
      email: tokenData.email,
      isPremium: tokenData.isPremium,
    });

    return true;
  } catch (err) {
    console.error(`[spotify-auth] Failed to refresh token for user ${discordUserId}:`, err.message);
    return false;
  }
}

/**
 * Get a valid access token for a Discord user, auto-refreshing if needed.
 * @param {string} discordUserId
 * @returns {Promise<string|null>} access token string, or null if user not connected
 */
async function getAccessToken(discordUserId) {
  const valid = await refreshTokenIfNeeded(discordUserId);
  if (!valid) return null;

  const tokenData = spotifyTokens.getToken(discordUserId);
  return tokenData ? tokenData.accessToken : null;
}

/**
 * Make an authenticated request to the Spotify Web API.
 * @param {string} accessToken
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
 * @param {string} endpoint - API endpoint path (without leading slash, e.g. "me" or "playlists/abc/tracks")
 * @param {object} [body] - request body (will be JSON-serialized)
 * @returns {Promise<object>} parsed JSON response
 */
async function spotifyApi(accessToken, method, endpoint, body) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`https://api.spotify.com/v1/${endpoint}`, opts);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Spotify API ${method} /${endpoint} failed (${res.status}): ${errText}`);
  }

  // Some endpoints return 204 No Content
  if (res.status === 204) return {};
  return res.json();
}

/**
 * Get a user's top tracks from Spotify.
 * @param {string} discordUserId
 * @param {string} [timeRange='medium_term'] - short_term, medium_term, or long_term
 * @param {number} [limit=50]
 * @returns {Promise<object>} Spotify top tracks response
 */
async function getUserTopTracks(discordUserId, timeRange = 'medium_term', limit = 50) {
  const accessToken = await getAccessToken(discordUserId);
  if (!accessToken) throw new Error('User not connected to Spotify');
  const params = new URLSearchParams({ time_range: timeRange, limit: String(limit) });
  return spotifyApi(accessToken, 'GET', `me/top/tracks?${params.toString()}`);
}

/**
 * Get a user's top artists from Spotify.
 * @param {string} discordUserId
 * @param {string} [timeRange='medium_term'] - short_term, medium_term, or long_term
 * @param {number} [limit=50]
 * @returns {Promise<object>} Spotify top artists response
 */
async function getUserTopArtists(discordUserId, timeRange = 'medium_term', limit = 50) {
  const accessToken = await getAccessToken(discordUserId);
  if (!accessToken) throw new Error('User not connected to Spotify');
  const params = new URLSearchParams({ time_range: timeRange, limit: String(limit) });
  return spotifyApi(accessToken, 'GET', `me/top/artists?${params.toString()}`);
}

/**
 * Search for tracks on Spotify.
 * @param {string} accessToken
 * @param {string} query - search query
 * @param {number} [limit=20]
 * @returns {Promise<object>} Spotify search response
 */
async function searchTracks(accessToken, query, limit = 20) {
  const params = new URLSearchParams({ q: query, type: 'track', limit: String(limit) });
  return spotifyApi(accessToken, 'GET', `search?${params.toString()}`);
}

/**
 * Create a new playlist for a Spotify user.
 * @param {string} discordUserId
 * @param {string} name - playlist name
 * @param {string} description - playlist description
 * @param {boolean} [isPublic=false]
 * @returns {Promise<object>} Spotify playlist object
 */
async function createPlaylist(discordUserId, name, description, isPublic = false) {
  const accessToken = await getAccessToken(discordUserId);
  if (!accessToken) throw new Error('User not connected to Spotify');

  const tokenData = spotifyTokens.getToken(discordUserId);
  return spotifyApi(accessToken, 'POST', `users/${tokenData.spotifyUserId}/playlists`, {
    name,
    description,
    public: isPublic,
  });
}

/**
 * Add tracks to a playlist, batching in groups of 100 (Spotify API limit).
 * @param {string} accessToken
 * @param {string} playlistId
 * @param {string[]} trackUris - array of Spotify track URIs (e.g. "spotify:track:xxx")
 * @returns {Promise<void>}
 */
async function addTracksToPlaylist(accessToken, playlistId, trackUris) {
  for (let i = 0; i < trackUris.length; i += 100) {
    const batch = trackUris.slice(i, i + 100);
    await spotifyApi(accessToken, 'POST', `playlists/${playlistId}/tracks`, {
      uris: batch,
    });
  }
}

module.exports = {
  getAuthUrl,
  handleCallback,
  refreshTokenIfNeeded,
  getAccessToken,
  spotifyApi,
  getUserTopTracks,
  getUserTopArtists,
  searchTracks,
  createPlaylist,
  addTracksToPlaylist,
};
