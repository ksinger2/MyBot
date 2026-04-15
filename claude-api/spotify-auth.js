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
  'playlist-read-collaborative',
  'user-read-private',
  'user-read-email',
  'user-top-read',
  'user-library-read',
  'user-library-modify',
  'user-follow-read',
  'user-follow-modify',
  'user-read-recently-played',
  'ugc-image-upload',
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

  // Mark the profile connected synchronously so the setup page reflects
  // the state immediately when the callback returns.
  try {
    const userProfiles = require('./user-profiles');
    userProfiles.setProfile(discordUserId, { spotify_connected: true, spotify_email: email, spotify_user_id: spotifyUserId });
  } catch (err) {
    console.warn(`[spotify] setProfile post-connect failed: ${err.message}`);
  }

  // NOTE: artist import is NOT awaited here. For users with large
  // libraries (500+ followed/liked), the import takes 30-120s of
  // sequential API calls. Awaiting it here blocks the HTTP response to
  // the OAuth callback — the browser times out, the user reloads, and
  // the retry hits the same callback URL with a state token that's
  // already been consumed (one-time use), producing "OAuth state not
  // found or expired". The caller (server.js) is responsible for
  // kicking off importUserArtists() in the background AFTER it has
  // responded to the browser.

  return {
    userId: discordUserId,
    displayName,
    email,
    spotifyUserId,
    isPremium,
    accessToken: tokens.access_token, // passed through so caller can kick off import without re-auth
  };
}

/**
 * Import a user's artists from Spotify as profile tags.
 *
 * Pulls from four sources in order — top artists (all 3 time ranges),
 * followed artists, saved/liked tracks, and saved albums. Errors in
 * individual sections are captured (not swallowed) so partial failures
 * are visible in the returned summary.
 *
 * @param {string} userId — profile key (Signal phone or Discord user id)
 * @param {string} [accessToken] — optional pre-acquired token; auto-fetches if omitted
 * @returns {Promise<{imported:number, unique:number, sources:object, errors:string[]}>}
 */
async function importUserArtists(userId, accessToken) {
  const userProfiles = require('./user-profiles');
  const token = accessToken || await getAccessToken(userId);
  if (!token) throw new Error('no spotify token for user');

  // Fetch profile once; mutate in-memory; write once at the end. This
  // avoids ~500 disk writes per run and lets us *upgrade* an existing
  // non-Artist tag (e.g. "Jack Johnson" stored as 'Custom' from a prior
  // !remember) in place instead of hitting the label-dedup block in
  // userProfiles.addTag and silently dropping the import.
  const profile = userProfiles.getProfile(userId) || {};
  if (!profile.tags) profile.tags = [];
  const tagsByLabel = new Map();
  for (const t of profile.tags) tagsByLabel.set(t.label.toLowerCase(), t);

  const seen = new Set();
  let imported = 0;
  let upgraded = 0;
  // raw = how many names the Spotify API returned from this source (pre-dedup)
  // added = how many of those were NEW (not already seen in an earlier source)
  const sources = {
    top:       { raw: 0, added: 0 },
    followed:  { raw: 0, added: 0 },
    liked:     { raw: 0, added: 0 },
    albums:    { raw: 0, added: 0 },
    recent:    { raw: 0, added: 0 },
    playlists: { raw: 0, added: 0 },
  };
  const errors = [];

  const tryAdd = (name, bucket) => {
    if (!name) return;
    sources[bucket].raw++;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    sources[bucket].added++;

    const existing = tagsByLabel.get(key);
    if (existing) {
      // Spotify is authoritative for "is this an artist?" — upgrade the
      // category if a tag with this label already exists under some other
      // category (usually 'Custom' from conversation-learned memories).
      if (existing.category !== 'Artist') {
        existing.category = 'Artist';
        upgraded++;
      }
      return;
    }

    const normalizedLabel = name.trim().substring(0, 100);
    if (!normalizedLabel) return;
    if (profile.tags.length >= 500) return;
    const tag = { label: normalizedLabel, category: 'Artist', addedAt: new Date().toISOString() };
    profile.tags.push(tag);
    tagsByLabel.set(key, tag);
    imported++;
  };

  for (const range of ['short_term', 'medium_term', 'long_term']) {
    try {
      const top = await spotifyApi(token, 'GET', `me/top/artists?time_range=${range}&limit=50`);
      for (const a of (top.items || [])) tryAdd(a.name, 'top');
    } catch (e) { errors.push(`top-${range}: ${e.message.slice(0, 200)}`); }
  }

  try {
    let after = null;
    let pagesFetched = 0;
    for (let page = 0; page < 20; page++) {
      const url = `me/following?type=artist&limit=50${after ? '&after=' + after : ''}`;
      const followed = await spotifyApi(token, 'GET', url);
      const items = followed.artists?.items || [];
      pagesFetched++;
      if (items.length === 0) break;
      for (const a of items) tryAdd(a.name, 'followed');
      // Prefer the cursor from the API response; fall back to last item id.
      after = followed.artists?.cursors?.after || items[items.length - 1]?.id;
      if (!followed.artists?.next) break;
    }
    if (pagesFetched > 0) errors.push(`followed: ok (${pagesFetched}p)`);
  } catch (e) { errors.push(`followed: ${e.message.slice(0, 200)}`); }

  try {
    for (let offset = 0; offset < 2000; offset += 50) {
      const saved = await spotifyApi(token, 'GET', `me/tracks?limit=50&offset=${offset}`);
      const items = saved.items || [];
      if (items.length === 0) break;
      for (const item of items) {
        for (const a of (item.track?.artists || [])) tryAdd(a.name, 'liked');
      }
      if (!saved.next) break;
    }
  } catch (e) { errors.push(`liked: ${e.message.slice(0, 200)}`); }

  try {
    for (let offset = 0; offset < 1000; offset += 50) {
      const albums = await spotifyApi(token, 'GET', `me/albums?limit=50&offset=${offset}`);
      const items = albums.items || [];
      if (items.length === 0) break;
      for (const item of items) {
        for (const a of (item.album?.artists || [])) tryAdd(a.name, 'albums');
      }
      if (!albums.next) break;
    }
  } catch (e) { errors.push(`albums: ${e.message.slice(0, 200)}`); }

  // Recently-played: last 50 tracks the user listened to. Catches artists
  // that aren't in top/followed/liked yet (Daily Mix, radio, autoplay).
  // Requires user-read-recently-played scope.
  try {
    const recent = await spotifyApi(token, 'GET', `me/player/recently-played?limit=50`);
    for (const item of (recent.items || [])) {
      for (const a of (item.track?.artists || [])) tryAdd(a.name, 'recent');
    }
  } catch (e) { errors.push(`recent: ${e.message.slice(0, 200).replace(/\s+/g, ' ')}`); }

  // Playlists source is disabled: on 2024-11-27, Spotify restricted
  // GET /playlists/{id}/tracks to apps in Extended Quota Mode only (along
  // with audio-features, recommendations, related-artists, etc). Personal
  // apps 403 on every playlist tracks call, even on the user's own private
  // playlists. Confirmed by testing — playlist *metadata* works but the
  // /tracks endpoint does not. Keeping the `playlists` source key in the
  // returned shape so existing callers don't break; it will just report
  // raw=0, added=0 always.

  // Single write at the end — all adds and category upgrades persist here.
  if (imported > 0 || upgraded > 0) {
    userProfiles.setProfile(userId, profile);
  }

  const summary = { imported, upgraded, unique: seen.size, sources, errors };
  console.log(`[spotify] importUserArtists(${userId.slice(0, 6)}…): ${JSON.stringify(summary)}`);
  return summary;
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

// Back-compat alias — older callers (server.js /spotify/refresh-artists) used
// this name. Returns the same { imported, unique, sources, errors } shape.
const refreshArtists = importUserArtists;

module.exports = {
  getAuthUrl,
  handleCallback,
  importUserArtists,
  refreshArtists,
  refreshTokenIfNeeded,
  getAccessToken,
  spotifyApi,
  getUserTopTracks,
  getUserTopArtists,
  searchTracks,
  createPlaylist,
  addTracksToPlaylist,
};
