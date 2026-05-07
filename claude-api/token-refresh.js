const { execFile } = require('child_process');

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function refreshToken() {
  execFile('claude', ['--version'], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[token-refresh] Failed to refresh CLI token:', err.message);
      if (stderr) console.error('[token-refresh] stderr:', stderr.trim());
      return;
    }
    console.log('[token-refresh] CLI token kept warm — claude', stdout.trim());
  });
}

function startTokenRefresh() {
  refreshToken();
  const timer = setInterval(refreshToken, REFRESH_INTERVAL_MS);
  timer.unref();
  console.log(`[token-refresh] Heartbeat started — every ${REFRESH_INTERVAL_MS / 60000}min`);
}

module.exports = { startTokenRefresh };
