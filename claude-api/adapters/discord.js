/**
 * DiscordAdapter — Wraps discord.js Client as a MessagePlatform adapter.
 *
 * This adapter normalizes Discord events into the same interface as SignalAdapter
 * so bot logic can be platform-agnostic.
 *
 * Usage:
 *   const adapter = new DiscordAdapter({ token: process.env.DISCORD_BOT_TOKEN });
 *   adapter.on('message', (msg) => console.log(msg.text));
 *   await adapter.start();
 */

const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const { MessagePlatform, NormalizedMessage } = require('./base');

class DiscordAdapter extends MessagePlatform {
  /**
   * @param {object} [opts]
   * @param {string} [opts.token] - Discord bot token (defaults to DISCORD_BOT_TOKEN env var)
   * @param {Client} [opts.client] - Existing discord.js Client to reuse (F23: avoids creating a
   *   second Client when bot.js already has one). When provided, the adapter skips Client creation
   *   and event wiring — the caller owns the Client lifecycle.
   */
  constructor(opts = {}) {
    super(opts);
    this.platform = 'discord';
    this.token = opts.token || process.env.DISCORD_BOT_TOKEN;

    if (opts.client) {
      // F23: Reuse an existing discord.js Client (bot.js already has one).
      // The caller is responsible for login/ready/event wiring.
      this.client = opts.client;
      this.ready = this.client.isReady?.() || false;
    } else {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel],
      });

      // Wire up Discord events → normalized events
      this.client.on('messageCreate', (msg) => this._handleMessage(msg));
      this.client.on('interactionCreate', (interaction) => this.emit('interaction', interaction));
    }
  }

  async start() {
    // F23: If constructed with an existing client that's already ready, skip login
    if (this.client.isReady?.()) {
      this.ready = true;
      return;
    }

    if (!this.token) {
      throw new Error('DiscordAdapter: token is required (set DISCORD_BOT_TOKEN env var)');
    }

    return new Promise((resolve, reject) => {
      this.client.once('ready', () => {
        this.ready = true;
        console.log(`[discord] Logged in as ${this.client.user.tag}`);
        console.log(`[discord] In ${this.client.guilds.cache.size} server(s)`);
        this.emit('ready');
        resolve();
      });
      this.client.login(this.token).catch(reject);
    });
  }

  async stop() {
    this.ready = false;
    await this.client.destroy();
    console.log('[discord] Adapter stopped');
  }

  /**
   * Send a message to a Discord channel.
   * @param {string} chatId - Discord channel ID
   * @param {string} text - Message text
   * @param {object} [opts]
   * @param {string} [opts.replyTo] - Message ID to reply to (requires raw message ref)
   * @param {Buffer[]} [opts.attachments] - File buffers
   * @param {string[]} [opts.attachmentNames] - Filenames
   * @param {object} [opts.rawMessage] - Original Discord message to reply to
   */
  async sendMessage(chatId, text, opts = {}) {
    const channel = await this.client.channels.fetch(chatId).catch(() => null);
    if (!channel) return { id: null, error: 'Channel not found' };

    const files = [];
    if (opts.attachments) {
      opts.attachments.forEach((buf, i) => {
        const name = opts.attachmentNames?.[i] || `file_${i}`;
        files.push(new AttachmentBuilder(buf, { name }));
      });
    }

    const sendOpts = { content: text };
    if (files.length) sendOpts.files = files;

    try {
      let sent;
      if (opts.rawMessage) {
        sent = await opts.rawMessage.reply(sendOpts);
      } else {
        sent = await channel.send(sendOpts);
      }
      return { id: sent.id };
    } catch (err) {
      console.error(`[discord] Send error: ${err.message}`);
      return { id: null, error: err.message };
    }
  }

  /**
   * Send a long message with Discord-specific chunking + .txt fallback.
   */
  async sendLongMessage(chatId, text, opts = {}) {
    if (!text || text.length === 0) {
      return; // Silently skip — caller handles turn-limit messaging
    }

    const limit = this.getCharLimit();
    if (text.length <= limit) {
      return this.sendMessage(chatId, text, opts);
    }

    // Split into chunks
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit - 10) { chunks.push(remaining); break; }
      let splitAt = remaining.lastIndexOf('\n', limit - 10);
      if (splitAt < limit * 0.25) splitAt = limit - 10;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt);
    }

    // Send first chunk as reply if we have rawMessage
    await this.sendMessage(chatId, chunks[0], opts);

    if (chunks.length > 8) {
      // Send first 4 inline, then upload full as .txt
      for (let i = 1; i < Math.min(chunks.length, 4); i++) {
        await this.sendMessage(chatId, chunks[i]);
      }
      const fullBuf = Buffer.from(text, 'utf-8');
      await this.sendMessage(chatId, `*Response too long (${chunks.length} chunks). Full text attached:*`, {
        attachments: [fullBuf],
        attachmentNames: ['full-response.txt'],
      });
    } else {
      for (let i = 1; i < chunks.length; i++) {
        await this.sendMessage(chatId, chunks[i]);
      }
    }
  }

  async sendTyping(chatId) {
    const channel = await this.client.channels.fetch(chatId).catch(() => null);
    if (channel) await channel.sendTyping().catch(() => {});
  }

  async fetchChat(chatId) {
    const channel = await this.client.channels.fetch(chatId).catch(() => null);
    if (!channel) return null;
    return { id: channel.id, name: channel.name || chatId };
  }

  getCharLimit() { return 1900; } // Discord is 2000 but leave margin

  getSupportedFeatures() {
    return ['text', 'attachments', 'reactions', 'threads', 'embeds', 'buttons', 'typing'];
  }

  /** Get the underlying discord.js Client (for Discord-specific operations) */
  getClient() { return this.client; }

  // --- Internal ---

  _handleMessage(msg) {
    if (msg.author.bot) return;

    const attachments = msg.attachments?.map(att => ({
      name: att.name,
      type: att.contentType,
      url: att.url,
      size: att.size,
    })) || [];

    const normalized = new NormalizedMessage({
      id: msg.id,
      platform: 'discord',
      chatId: msg.channel.id,
      senderId: msg.author.id,
      senderName: msg.author.username,
      text: msg.content || '',
      attachments,
      timestamp: msg.createdTimestamp,
      raw: msg, // keep Discord message for reply(), reactions, etc.
    });

    this.emit('message', normalized);
  }
}

module.exports = { DiscordAdapter };
