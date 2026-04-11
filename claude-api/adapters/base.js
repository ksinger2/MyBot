/**
 * MessagePlatform — base adapter interface for messaging platforms.
 *
 * Reusable across projects. Subclass this for Discord, Signal, etc.
 * All bot logic talks to this interface, never to platform-specific APIs directly.
 *
 * Usage:
 *   const adapter = new DiscordAdapter({ token: '...' });
 *   adapter.on('message', (msg) => { ... });
 *   adapter.start();
 */

const EventEmitter = require('events');

class MessagePlatform extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.platform = 'base';       // override in subclass: 'discord', 'signal'
    this.ready = false;
    this.opts = opts;
  }

  /** Start the adapter (connect, authenticate, begin listening) */
  async start() { throw new Error('start() not implemented'); }

  /** Stop the adapter (disconnect, cleanup) */
  async stop() { throw new Error('stop() not implemented'); }

  /**
   * Send a text message to a chat.
   * @param {string} chatId - Channel/conversation/phone number
   * @param {string} text - Message text
   * @param {object} [opts] - Platform-specific options
   * @param {string} [opts.replyTo] - Message ID to reply to
   * @param {Buffer[]} [opts.attachments] - File buffers to attach
   * @param {string[]} [opts.attachmentNames] - Filenames for attachments
   * @returns {Promise<{id: string}>} - Sent message reference
   */
  async sendMessage(chatId, text, opts = {}) { throw new Error('sendMessage() not implemented'); }

  /**
   * Send a long message, splitting if needed for platform limits.
   * Default implementation splits at platform's char limit.
   * @param {string} chatId
   * @param {string} text
   * @param {object} [opts]
   */
  async sendLongMessage(chatId, text, opts = {}) {
    const limit = this.getCharLimit();
    if (!limit || text.length <= limit) {
      return this.sendMessage(chatId, text, opts);
    }

    // Split on newlines near the limit
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit) { chunks.push(remaining); break; }
      let splitAt = remaining.lastIndexOf('\n', limit);
      if (splitAt < limit * 0.25) splitAt = limit;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt);
    }

    const results = [];
    for (const chunk of chunks) {
      results.push(await this.sendMessage(chatId, chunk, opts));
    }
    return results;
  }

  /** Show typing indicator in a chat */
  async sendTyping(chatId) { /* optional — no-op by default */ }

  /**
   * Fetch a chat/channel object by ID. Returns null if not found.
   * @param {string} chatId
   * @returns {Promise<{id: string, name?: string}|null>}
   */
  async fetchChat(chatId) { return null; }

  /** Get platform-specific character limit, or null for unlimited */
  getCharLimit() { return null; }

  /** Get platform name string */
  getPlatform() { return this.platform; }

  /** Check if platform supports a feature */
  supports(feature) {
    const features = this.getSupportedFeatures();
    return features.includes(feature);
  }

  /** List supported features. Override in subclass. */
  getSupportedFeatures() {
    return ['text']; // minimum: text messaging
  }
}

/**
 * Normalized message object emitted by all adapters.
 *
 * adapter.on('message', (msg: NormalizedMessage) => { ... })
 */
class NormalizedMessage {
  constructor({
    id,
    platform,
    chatId,
    senderId,
    senderName = null,
    text = '',
    attachments = [],
    mentions = [],
    timestamp = Date.now(),
    raw = null,        // original platform-specific message object
  }) {
    this.id = id;
    this.platform = platform;
    this.chatId = chatId;
    this.senderId = senderId;
    this.senderName = senderName;
    this.text = text;
    this.attachments = attachments; // [{ name, type, id, size, localPath }]
    this.mentions = mentions;       // [{ number, uuid, name, start, length }]
    this.timestamp = timestamp;
    this.raw = raw;
  }
}

module.exports = { MessagePlatform, NormalizedMessage };
