const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');

const execFileAsync = promisify(execFile);

const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes — aggressive to catch expiry early
const PROACTIVE_REFRESH_MINUTES = 120; // trigger refresh when < 2hr remaining
const EXPIRY_WARN_MINUTES = 30; // only alert owner if proactive refresh FAILS

const WINDOWS_CREDS = '/host/windows-claude-credentials.json';
const ACTIVE_CREDS = '/home/node/.claude/.credentials.json';

let _ownerNotifiedAt = 0;
let _loginInProgress = false;
let _lastProactiveRefreshAt = 0;

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
      } catch {}

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

    const proc = spawn('claude', ['auth', 'login', '--claudeai'], {
      env: { ...process.env, BROWSER: 'echo', DISPLAY: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/(https:\/\/claude\.com\/[^\s]+)/);
      if (match && !url) {
        url = match[1];
        resolve({ process: proc, url });
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/(https:\/\/claude\.com\/[^\s]+)/);
      if (match && !url) {
        url = match[1];
        resolve({ process: proc, url });
      }
    });

    proc.on('error', (err) => {
      _loginInProgress = false;
      if (!url) reject(err);
    });

    proc.on('close', (code) => {
      _loginInProgress = false;
      if (!url) {
        reject(new Error(`Login process exited (code ${code}) without producing URL`));
      }
    });

    setTimeout(() => {
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
    const { sendErrorAlert } = require('./error-alerting');
    const msg = minsLeft <= 0
      ? 'Auth token expired — send !login to re-authenticate'
      : `Auth token expires in ${minsLeft}min — send !login if refresh doesn't recover`;
    await sendErrorAlert(
      new Error(msg),
      { source: 'auth' }
    );
    _ownerNotifiedAt = Date.now();
  } catch {}
}

/**
 * Proactive token refresh: runs a minimal Claude CLI command that forces the
 * SDK to hit the auth endpoint. When a token is near expiry, the CLI
 * automatically exchanges the refresh_token for a new access_token.
 *
 * Returns true if refresh succeeded (token extended), false otherwise.
 */
async function _proactiveRefresh() {
  const cooldown = 5 * 60_000;
  if (Date.now() - _lastProactiveRefreshAt < cooldown) return false;
  _lastProactiveRefreshAt = Date.now();

  console.log('[token-refresh] Proactive refresh — syncing credentials and testing CLI...');
  const beforeExpiry = getTokenExpiryMinutes();

  // Step 1: Sync Windows credentials first — this is free and often sufficient
  syncWindowsCredentials();
  const afterSync = getTokenExpiryMinutes();
  if (afterSync !== null && afterSync > (beforeExpiry || 0) + 30) {
    console.log(`[token-refresh] Windows sync refreshed token! ${beforeExpiry}min → ${afterSync}min remaining`);
    try { require('./sandbox').refreshAllCredentials(); } catch {}
    return true;
  }

  // Step 2: Run a minimal prompt to force the SDK through the auth layer.
  // `claude --version` does NOT trigger OAuth exchange — it exits before init.
  try {
    await execFileAsync('claude', ['-p', 'respond with only the word ok', '--max-turns', '1', '--output-format', 'text'], {
      timeout: 45000,
      env: { ...process.env, HOME: '/home/node' },
    });
  } catch (err) {
    console.error('[token-refresh] Proactive refresh (prompt) failed:', err.message);
    return false;
  }

  const afterPrompt = getTokenExpiryMinutes();
  if (afterPrompt !== null && afterPrompt > (beforeExpiry || 0) + 30) {
    console.log(`[token-refresh] Token refreshed via prompt! ${beforeExpiry}min → ${afterPrompt}min remaining`);
    try { require('./sandbox').refreshAllCredentials(); } catch {}
    return true;
  }

  console.log(`[token-refresh] CLI ran but token not extended (${beforeExpiry}min → ${getTokenExpiryMinutes()}min)`);
  return false;
}

async function refreshToken() {
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
  console.warn(`[token-refresh] Token low (${minsLeft}min remaining) — attempting proactive refresh`);
  const refreshed = await _proactiveRefresh();

  if (refreshed) return;

  // Proactive refresh didn't work — if really low, alert owner
  const minsAfter = getTokenExpiryMinutes() || minsLeft;
  if (minsAfter <= EXPIRY_WARN_MINUTES) {
    console.error(`[token-refresh] Proactive refresh failed, token critical (${minsAfter}min)`);
    await notifyOwnerAuthExpiring(minsAfter);
  }
}

function startTokenRefresh() {
  refreshToken();
  const timer = setInterval(refreshToken, REFRESH_INTERVAL_MS);
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
