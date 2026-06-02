const { spawn } = require('child_process');
const fs = require('fs');

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const PROACTIVE_REFRESH_MINUTES = 120; // trigger refresh when < 2hr remaining
const EXPIRY_WARN_MINUTES = 30; // only alert owner if proactive refresh FAILS

const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

const WINDOWS_CREDS = '/host/windows-claude-credentials.json';
const ACTIVE_CREDS = '/home/node/.claude/.credentials.json';

let _ownerNotifiedAt = 0;
let _loginInProgress = false;
let _lastProactiveRefreshAt = 0;
let _refreshInProgress = false;

function isLoginInProgress() { return _loginInProgress; }
function setLoginInProgress(v) { _loginInProgress = !!v; }

function syncWindowsCredentials() {
  try {
    if (!fs.existsSync(WINDOWS_CREDS)) return false;

    const winRaw = fs.readFileSync(WINDOWS_CREDS, 'utf8');
    let activeRaw = '';
    try { activeRaw = fs.readFileSync(ACTIVE_CREDS, 'utf8'); } catch {}

    if (winRaw && winRaw !== activeRaw) {
      try {
        const winParsed = JSON.parse(winRaw);
        const activeParsed = activeRaw ? JSON.parse(activeRaw) : {};
        const winExpiry = winParsed?.claudeAiOauth?.expiresAt || 0;
        const activeExpiry = activeParsed?.claudeAiOauth?.expiresAt || 0;
        if (winExpiry <= activeExpiry) return false;
      } catch { return false; }

      const tmpPath = ACTIVE_CREDS + '.tmp.' + process.pid;
      fs.writeFileSync(tmpPath, winRaw, { mode: 0o600 });
      fs.renameSync(tmpPath, ACTIVE_CREDS);
      console.log('[token-refresh] Synced fresh credentials from Windows host');
      return true;
    }
  } catch (err) {
    console.warn('[token-refresh] Failed to sync Windows credentials:', err.message);
  }
  return false;
}

function getTokenExpiryMinutes() {
  try {
    const creds = JSON.parse(fs.readFileSync(ACTIVE_CREDS, 'utf8'));
    const exp = creds?.claudeAiOauth?.expiresAt;
    if (!exp) return null;
    return Math.round((exp - Date.now()) / 60000);
  } catch { return null; }
}

function runHeadlessLogin() {
  return new Promise((resolve, reject) => {
    if (_loginInProgress) return reject(new Error('Login already in progress'));
    _loginInProgress = true;
    let url = null;
    let stderr = '';
    let urlTimer = null;

    const proc = spawn('claude', ['auth', 'login', '--claudeai'], {
      env: { ...process.env, BROWSER: 'echo', DISPLAY: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });

    function onUrlFound(foundUrl) {
      if (url) return;
      url = foundUrl;
      if (urlTimer) clearTimeout(urlTimer);
      resolve({ process: proc, url });
    }

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/(https:\/\/claude\.com\/[^\s]+)/);
      if (match) onUrlFound(match[1]);
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/(https:\/\/claude\.com\/[^\s]+)/);
      if (match) onUrlFound(match[1]);
    });

    proc.on('error', (err) => {
      if (urlTimer) clearTimeout(urlTimer);
      _loginInProgress = false;
      if (!url) reject(err);
    });

    proc.on('close', (code) => {
      if (urlTimer) clearTimeout(urlTimer);
      _loginInProgress = false;
      if (!url) {
        reject(new Error(`Login process exited (code ${code}) without producing URL`));
      }
    });

    urlTimer = setTimeout(() => {
      if (!url) {
        proc.kill();
        _loginInProgress = false;
        reject(new Error('Login timed out waiting for URL'));
      }
    }, 30000);
  });
}

async function notifyOwnerAuthExpiring(minsLeft) {
  if (Date.now() - _ownerNotifiedAt < 60 * 60 * 1000) return;
  try {
    _ownerNotifiedAt = Date.now();
    const { sendErrorAlert } = require('./error-alerting');
    const msg = minsLeft <= 0
      ? 'Auth token expired — send !login to re-authenticate'
      : `Auth token expires in ${minsLeft}min — send !login if refresh doesn't recover`;
    await sendErrorAlert(
      new Error(msg),
      { source: 'auth' }
    );
  } catch {}
}

/**
 * Direct OAuth2 token refresh — POST to platform.claude.com/v1/oauth/token
 * with the refresh_token. No CLI spawn, no SDK dependency, no DPoP.
 *
 * Returns true if refresh succeeded (token extended), false otherwise.
 */
async function _proactiveRefresh() {
  const cooldown = 5 * 60_000;
  if (Date.now() - _lastProactiveRefreshAt < cooldown) return false;

  console.log('[token-refresh] Proactive refresh — syncing credentials then direct OAuth...');
  const beforeExpiry = getTokenExpiryMinutes();

  // Step 1: Sync Windows credentials first — this is free and often sufficient
  syncWindowsCredentials();
  const afterSync = getTokenExpiryMinutes();
  if (afterSync !== null && afterSync > (beforeExpiry || 0) + 30) {
    _lastProactiveRefreshAt = Date.now();
    console.log(`[token-refresh] Windows sync refreshed token! ${beforeExpiry}min → ${afterSync}min remaining`);
    try { require('./sandbox').refreshAllCredentials(); } catch {}
    return true;
  }

  // Step 2: Direct OAuth2 refresh — hit the token endpoint with refresh_token
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(ACTIVE_CREDS, 'utf8'));
  } catch (err) {
    console.error('[token-refresh] Cannot read credentials:', err.message);
    return false;
  }

  const refreshToken = creds?.claudeAiOauth?.refreshToken;
  if (!refreshToken) {
    console.error('[token-refresh] No refresh_token in credentials');
    return false;
  }

  try {
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[token-refresh] OAuth refresh HTTP ${resp.status}: ${text.substring(0, 200)}`);
      return false;
    }

    const data = await resp.json();
    if (!data.access_token || !data.expires_in) {
      console.error('[token-refresh] OAuth response missing access_token or expires_in');
      return false;
    }

    // Write new credentials atomically
    const updated = {
      claudeAiOauth: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        scopes: (data.scope || OAUTH_SCOPES).split(' '),
        subscriptionType: creds.claudeAiOauth.subscriptionType || 'max',
        rateLimitTier: creds.claudeAiOauth.rateLimitTier || 'default_claude_max_20x',
      },
    };

    const tmpPath = ACTIVE_CREDS + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(updated), { mode: 0o600 });
    fs.renameSync(tmpPath, ACTIVE_CREDS);

    _lastProactiveRefreshAt = Date.now();
    const afterRefresh = getTokenExpiryMinutes();
    console.log(`[token-refresh] OAuth refresh succeeded! ${beforeExpiry}min → ${afterRefresh}min remaining`);
    try { require('./sandbox').refreshAllCredentials(); } catch {}
    return true;
  } catch (err) {
    console.error('[token-refresh] OAuth refresh failed:', err.message);
    return false;
  }
}

async function refreshToken() {
  if (_refreshInProgress) return;
  _refreshInProgress = true;
  try {
    const synced = syncWindowsCredentials();
    if (synced) {
      try { require('./sandbox').refreshAllCredentials(); } catch {}
    }

    const minsLeft = getTokenExpiryMinutes();
    if (minsLeft === null) {
      console.warn('[token-refresh] Cannot read token expiry');
      return;
    }

    if (minsLeft > PROACTIVE_REFRESH_MINUTES) {
      console.log(`[token-refresh] Token valid (${minsLeft}min remaining)`);
      return;
    }

    // Token is within the proactive refresh window — try to extend it
    console.warn(`[token-refresh] Token low (${minsLeft}min remaining) — attempting direct OAuth refresh`);
    const refreshed = await _proactiveRefresh();

    if (refreshed) return;

    // Direct refresh failed — alert owner if critically low
    const minsAfter = getTokenExpiryMinutes() || minsLeft;
    if (minsAfter <= EXPIRY_WARN_MINUTES) {
      console.error(`[token-refresh] Direct OAuth refresh failed, token critical (${minsAfter}min)`);
      await notifyOwnerAuthExpiring(minsAfter);
    }
  } finally {
    _refreshInProgress = false;
  }
}

function startTokenRefresh() {
  refreshToken().catch(err => console.error('[token-refresh] error:', err.message));
  const timer = setInterval(() => refreshToken().catch(err => console.error('[token-refresh] error:', err.message)), REFRESH_INTERVAL_MS);
  timer.unref();
  console.log(`[token-refresh] Heartbeat started — every ${REFRESH_INTERVAL_MS / 60000}min`);
}

module.exports = {
  startTokenRefresh,
  runHeadlessLogin,
  isLoginInProgress,
  setLoginInProgress,
  getTokenExpiryMinutes,
  syncWindowsCredentials,
};
