const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const WINDOWS_CREDS = '/host/windows-claude-credentials.json';
const ACTIVE_CREDS = '/home/node/.claude/.credentials.json';

// Anthropic OAuth2 endpoints (from /.well-known/oauth-authorization-server)
const TOKEN_ENDPOINT = 'https://api.anthropic.com/token';
const CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';

// Buffer: refresh 10 minutes before expiry
const EXPIRY_BUFFER_MS = 10 * 60 * 1000;

/**
 * Sync credentials from the Windows host mount (read-only) if they're fresher.
 * Handles the case where the user logs in from Windows and the WSL/Docker copy
 * has a stale token.
 */
function syncWindowsCredentials() {
  try {
    if (!fs.existsSync(WINDOWS_CREDS)) return false;

    const winRaw = fs.readFileSync(WINDOWS_CREDS, 'utf8');
    let activeRaw = '';
    try { activeRaw = fs.readFileSync(ACTIVE_CREDS, 'utf8'); } catch {}

    if (winRaw && winRaw !== activeRaw) {
      // Check if Windows token is actually newer (has later expiry)
      try {
        const winParsed = JSON.parse(winRaw);
        const activeParsed = activeRaw ? JSON.parse(activeRaw) : {};
        const winExpiry = winParsed?.claudeAiOauth?.expiresAt || 0;
        const activeExpiry = activeParsed?.claudeAiOauth?.expiresAt || 0;
        if (winExpiry <= activeExpiry) return false; // active is already newer
      } catch {}

      fs.writeFileSync(ACTIVE_CREDS, winRaw, { mode: 0o600 });
      console.log('[token-refresh] Synced fresh credentials from Windows host');
      return true;
    }
  } catch (err) {
    console.warn('[token-refresh] Failed to sync Windows credentials:', err.message);
  }
  return false;
}

/**
 * Use the OAuth2 refresh_token grant to get a new access token from Anthropic.
 * This is the same flow the Claude CLI uses internally. Public client (no secret).
 */
function refreshOAuthToken() {
  return new Promise((resolve, reject) => {
    let creds;
    try {
      creds = JSON.parse(fs.readFileSync(ACTIVE_CREDS, 'utf8'));
    } catch (err) {
      return reject(new Error(`Cannot read credentials: ${err.message}`));
    }

    const oauth = creds?.claudeAiOauth;
    if (!oauth?.refreshToken) {
      return reject(new Error('No refresh token available'));
    }

    // Check if token actually needs refreshing
    if (oauth.expiresAt && Date.now() < oauth.expiresAt - EXPIRY_BUFFER_MS) {
      const minsLeft = Math.round((oauth.expiresAt - Date.now()) / 60000);
      return resolve({ skipped: true, minsLeft });
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
    }).toString();

    const url = new URL(TOKEN_ENDPOINT);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Token refresh failed: HTTP ${res.statusCode} — ${data.substring(0, 200)}`));
        }
        try {
          const tokens = JSON.parse(data);
          // Update credentials file with new tokens
          creds.claudeAiOauth = {
            ...oauth,
            accessToken: tokens.access_token,
            // Refresh token may or may not be rotated
            refreshToken: tokens.refresh_token || oauth.refreshToken,
            expiresAt: tokens.expires_in
              ? Date.now() + tokens.expires_in * 1000
              : oauth.expiresAt,
          };
          fs.writeFileSync(ACTIVE_CREDS, JSON.stringify(creds), { mode: 0o600 });
          const minsLeft = Math.round(((creds.claudeAiOauth.expiresAt || 0) - Date.now()) / 60000);
          resolve({ refreshed: true, minsLeft });
        } catch (err) {
          reject(new Error(`Failed to parse token response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Token refresh timed out')); });
    req.write(body);
    req.end();
  });
}

async function refreshToken() {
  // Step 1: Sync from Windows if a fresher token is available
  syncWindowsCredentials();

  // Step 2: Proactively refresh the OAuth token if it's close to expiry
  try {
    const result = await refreshOAuthToken();
    if (result.skipped) {
      console.log(`[token-refresh] Token still valid (${result.minsLeft}min remaining)`);
    } else if (result.refreshed) {
      console.log(`[token-refresh] OAuth token refreshed (new expiry: ${result.minsLeft}min)`);
    }
  } catch (err) {
    console.error(`[token-refresh] OAuth refresh failed: ${err.message}`);
  }

  // Step 3: Verify CLI still works
  execFile('claude', ['--version'], { timeout: 15000 }, (err, stdout) => {
    if (err) {
      console.error('[token-refresh] CLI verification failed:', err.message);
      return;
    }
    console.log('[token-refresh] CLI verified — claude', stdout.trim());
  });
}

function startTokenRefresh() {
  refreshToken();
  const timer = setInterval(refreshToken, REFRESH_INTERVAL_MS);
  timer.unref();
  console.log(`[token-refresh] Heartbeat started — every ${REFRESH_INTERVAL_MS / 60000}min`);
}

module.exports = { startTokenRefresh };
