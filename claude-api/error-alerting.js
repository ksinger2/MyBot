const config = require('./briefing-config');

let _client = null;
const _recentErrors = new Map(); // dedupKey -> timestamp

function init(client) {
  _client = client;
}

async function sendErrorAlert(error, { source = 'unknown', channel = null, detail = null } = {}) {
  if (!_client || !config.errorChannelId) return;

  try {
    // Rate limit: same error type max once per 5 minutes
    const dedupKey = `${source}:${(error.message || '').substring(0, 50)}`;
    const now = Date.now();
    const lastSent = _recentErrors.get(dedupKey);
    if (lastSent && (now - lastSent) < 5 * 60 * 1000) return;
    _recentErrors.set(dedupKey, now);

    // Clean old entries
    if (_recentErrors.size > 100) {
      for (const [k, t] of _recentErrors) {
        if (now - t > 10 * 60 * 1000) _recentErrors.delete(k);
      }
    }

    const errChannel = await _client.channels.fetch(config.errorChannelId).catch(() => null);
    if (!errChannel) return;

    const errorMsg = error.message || String(error);
    const truncated = errorMsg.length > 800 ? errorMsg.substring(0, 800) + '...' : errorMsg;

    const parts = [`**Error in ${source}**`];
    if (channel) parts.push(`Channel: <#${channel}>`);
    if (detail) parts.push(detail);
    parts.push(`\`\`\`\n${truncated}\n\`\`\``);
    parts.push(`<t:${Math.floor(now / 1000)}:R>`);

    await errChannel.send(parts.join('\n'));
  } catch {
    // Never let error alerting itself throw
  }
}

module.exports = { init, sendErrorAlert };
