const config = require('./briefing-config');

let _client = null;
let _signalAdapter = null;
const _recentErrors = new Map(); // dedupKey -> timestamp

function init(client, signalAdapter) {
  _client = client;
  if (signalAdapter) _signalAdapter = signalAdapter;
}

function initSignal(signalAdapter) {
  _signalAdapter = signalAdapter;
}

async function sendErrorAlert(error, { source = 'unknown', channel = null, detail = null } = {}) {
  const now = Date.now();

  try {
    // Rate limit: same error type max once per 5 minutes
    const dedupKey = `${source}:${(error.message || '').substring(0, 50)}`;
    const lastSent = _recentErrors.get(dedupKey);
    if (lastSent && (now - lastSent) < 5 * 60 * 1000) return;
    _recentErrors.set(dedupKey, now);

    // Clean old entries
    if (_recentErrors.size > 100) {
      for (const [k, t] of _recentErrors) {
        if (now - t > 10 * 60 * 1000) _recentErrors.delete(k);
      }
    }

    const errorMsg = error.message || String(error);
    const truncated = errorMsg.length > 800 ? errorMsg.substring(0, 800) + '...' : errorMsg;

    // Discord alerting (if available)
    if (_client && config.errorChannelId) {
      try {
        const errChannel = await _client.channels.fetch(config.errorChannelId).catch(() => null);
        if (errChannel) {
          const parts = [`**Error in ${source}**`];
          if (channel) parts.push(`Channel: <#${channel}>`);
          if (detail) parts.push(detail);
          parts.push(`\`\`\`\n${truncated}\n\`\`\``);
          parts.push(`<t:${Math.floor(now / 1000)}:R>`);
          await errChannel.send(parts.join('\n'));
        }
      } catch {}
    }

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
