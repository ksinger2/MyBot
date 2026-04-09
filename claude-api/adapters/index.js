/**
 * Messaging Adapters — platform-agnostic messaging layer.
 *
 * Reusable across projects. Drop the adapters/ folder into any Node.js project
 * and use the same interface for Discord, Signal, iMessage, etc.
 *
 * Usage:
 *   const { DiscordAdapter, SignalAdapter, createAdapter } = require('./adapters');
 *
 *   // Create by name
 *   const adapter = createAdapter('signal', { phoneNumber: '+1...' });
 *
 *   // Or directly
 *   const discord = new DiscordAdapter({ token: '...' });
 *   const signal = new SignalAdapter({ phoneNumber: '+1...' });
 */

const { MessagePlatform, NormalizedMessage } = require('./base');
const { DiscordAdapter } = require('./discord');
const { SignalAdapter } = require('./signal');

const ADAPTERS = {
  discord: DiscordAdapter,
  signal: SignalAdapter,
};

/**
 * Factory — create an adapter by platform name.
 * @param {string} platform - 'discord', 'signal'
 * @param {object} opts - Platform-specific options
 * @returns {MessagePlatform}
 */
function createAdapter(platform, opts = {}) {
  const AdapterClass = ADAPTERS[platform];
  if (!AdapterClass) {
    throw new Error(`Unknown platform: ${platform}. Available: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return new AdapterClass(opts);
}

/**
 * Create adapters for all enabled platforms (from ENABLED_PLATFORMS env var).
 * @param {object} opts - Per-platform options keyed by platform name
 * @returns {Map<string, MessagePlatform>}
 */
function createEnabledAdapters(opts = {}) {
  const enabled = (process.env.ENABLED_PLATFORMS || 'discord').split(',').map(s => s.trim()).filter(Boolean);
  const adapters = new Map();
  for (const platform of enabled) {
    try {
      const adapter = createAdapter(platform, opts[platform] || {});
      adapters.set(platform, adapter);
    } catch (err) {
      console.error(`[adapters] Failed to create ${platform} adapter: ${err.message}`);
    }
  }
  return adapters;
}

module.exports = {
  MessagePlatform,
  NormalizedMessage,
  DiscordAdapter,
  SignalAdapter,
  createAdapter,
  createEnabledAdapters,
  ADAPTERS,
};
