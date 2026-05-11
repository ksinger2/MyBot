let _signalAdapter = null;
const _recentErrors = new Map(); // dedupKey -> timestamp

// Signal-only init. Accepts a Signal adapter (or nothing — the function is
// called early during boot before the adapter exists). The legacy two-arg
// `init(client, adapter)` signature is preserved by ignoring extra args.
function init(adapter) {
  if (adapter) _signalAdapter = adapter;
}

function initSignal(adapter) {
  _signalAdapter = adapter;
}

async function sendErrorAlert(error, { source = 'unknown', channel = null, detail = null } = {}) {
  const now = Date.now();

  try {
    // Rate limit: same error source max once per 15 minutes.
    // Use source + first 30 static chars to dedup (strip variable numbers).
    const msgStatic = (error.message || '').replace(/\d+/g, '#').substring(0, 30);
    const dedupKey = `${source}:${msgStatic}`;
    const lastSent = _recentErrors.get(dedupKey);
    if (lastSent && (now - lastSent) < 15 * 60 * 1000) return;
    _recentErrors.set(dedupKey, now);

    // Clean old entries
    if (_recentErrors.size > 100) {
      for (const [k, t] of _recentErrors) {
        if (now - t > 10 * 60 * 1000) _recentErrors.delete(k);
      }
    }

    const errorMsg = error.message || String(error);
    const truncated = errorMsg.length > 800 ? errorMsg.substring(0, 800) + '...' : errorMsg;

    // Signal alerting (if available)
    if (_signalAdapter?.ready) {
      try {
        const { SIGNAL_OWNER } = require('./project-permissions');
        if (SIGNAL_OWNER) {
          const msg = `Error in ${source}: ${truncated.substring(0, 500)}`;
          await _signalAdapter.sendMessage(SIGNAL_OWNER, msg);
        }
      } catch {}
    }
  } catch {
    // Never let error alerting itself throw
  }
}

module.exports = { init, initSignal, sendErrorAlert };
