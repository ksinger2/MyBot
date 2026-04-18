const { MessagePlatform, NormalizedMessage } = require('./base');
const { SignalAdapter } = require('./signal');

const ADAPTERS = { signal: SignalAdapter };

function createAdapter(platform, opts = {}) {
  const AdapterClass = ADAPTERS[platform];
  if (!AdapterClass) throw new Error(`Unknown platform: ${platform}. Available: ${Object.keys(ADAPTERS).join(', ')}`);
  return new AdapterClass(opts);
}

function createEnabledAdapters(opts = {}) {
  const enabled = (process.env.ENABLED_PLATFORMS || 'signal').split(',').map(s => s.trim()).filter(Boolean);
  const adapters = new Map();
  for (const platform of enabled) {
    try {
      adapters.set(platform, createAdapter(platform, opts[platform] || {}));
    } catch (err) {
      console.error(`[adapters] Failed to create ${platform} adapter: ${err.message}`);
    }
  }
  return adapters;
}

module.exports = { MessagePlatform, NormalizedMessage, SignalAdapter, createAdapter, createEnabledAdapters, ADAPTERS };
