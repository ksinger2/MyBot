/**
 * SignalAdapter — Messaging adapter for Signal via signal-cli-rest-api sidecar.
 *
 * Reusable across projects. Requires bbernhard/signal-cli-rest-api running as a
 * Docker sidecar container (or any host exposing the same REST API).
 *
 * Setup:
 *   1. Add signal-api service to docker-compose.yml (see README)
 *   2. Register a phone number: POST /v1/register/{number}
 *   3. Verify: POST /v1/register/{number}/verify/{code}
 *   4. Create adapter with apiUrl + phoneNumber
 *
 * Usage:
 *   const adapter = new SignalAdapter({
 *     apiUrl: 'http://signal-api:8080',
 *     phoneNumber: '+1234567890',
 *     pollInterval: 5000,
 *   });
 *   adapter.on('message', (msg) => console.log(msg.text));
 *   await adapter.start();
 */

const { MessagePlatform, NormalizedMessage } = require('./base');

class SignalAdapter extends MessagePlatform {
  constructor(opts = {}) {
    super(opts);
    this.platform = 'signal';
    this.apiUrl = (opts.apiUrl || process.env.SIGNAL_API_URL || 'http://signal-api:8080').replace(/\/$/, '');
    this.phoneNumber = opts.phoneNumber || process.env.SIGNAL_PHONE_NUMBER;
    this.pollInterval = opts.pollInterval || parseInt(process.env.SIGNAL_POLL_INTERVAL, 10) || 5000;
    this._pollTimer = null;
    this._stopping = false;

    // Track known conversations for chat metadata
    this._chats = new Map(); // chatId → { name, lastSeen }
  }

  async start() {
    if (!this.phoneNumber) {
      throw new Error('SignalAdapter: phoneNumber is required (set SIGNAL_PHONE_NUMBER env var or pass in opts)');
    }

    // Verify connectivity to signal-cli-rest-api
    try {
      const resp = await this._fetch('/v1/about');
      if (resp.ok) {
        const info = await resp.json();
        console.log(`[signal] Connected to signal-cli-rest-api v${info.versions?.['signal-cli'] || 'unknown'}`);
      } else {
        console.warn(`[signal] API responded with ${resp.status} — may need registration`);
      }
    } catch (err) {
      console.error(`[signal] Cannot reach ${this.apiUrl}: ${err.message}`);
      console.error('[signal] Make sure signal-api container is running');
      return;
    }

    // Start polling for incoming messages
    this._stopping = false;
    this._poll();
    this.ready = true;
    console.log(`[signal] Adapter started — polling every ${this.pollInterval}ms for ${this.phoneNumber}`);
    this.emit('ready');
  }

  async stop() {
    this._stopping = true;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this.ready = false;
    console.log('[signal] Adapter stopped');
  }

  /**
   * Send a text message.
   * @param {string} chatId - Recipient phone number (e.g. +1234567890) or group ID
   * @param {string} text - Message text
   * @param {object} [opts]
   * @param {Buffer[]} [opts.attachments] - File buffers
   * @param {string[]} [opts.attachmentNames] - Filenames
   */
  async sendMessage(chatId, text, opts = {}) {
    // Strip any prefix (e.g. "signal:") from chatId
    const recipient = chatId.replace(/^signal:/, '');

    const payload = {
      message: text,
      number: this.phoneNumber,
      text_mode: 'normal',
    };

    // Determine if chatId is a group or individual
    if (this._isGroupId(recipient)) {
      payload.group_id = recipient;
      // Do NOT set recipients for group sends — signal-cli-rest-api rejects empty arrays
    } else {
      payload.recipients = [recipient];
    }

    console.log(`[signal] Sending to ${recipient}: ${text.substring(0, 50)}...`);

    // Handle attachments
    if (opts.attachments && opts.attachments.length > 0) {
      payload.base64_attachments = opts.attachments.map((buf, i) => {
        const name = opts.attachmentNames?.[i] || `file_${i}`;
        const base64 = buf.toString('base64');
        // Signal REST API expects: "data:application/octet-stream;filename=name;base64,DATA"
        return `data:application/octet-stream;filename=${name};base64,${base64}`;
      });
    }

    try {
      const resp = await this._fetch('/v2/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error(`[signal] Send failed (${resp.status}): ${errText}`);
        return { id: null, error: errText };
      }

      const result = await resp.json().catch(() => ({}));
      return { id: result.timestamp || Date.now().toString() };
    } catch (err) {
      console.error(`[signal] Send error: ${err.message}`);
      return { id: null, error: err.message };
    }
  }

  async fetchChat(chatId) {
    const cached = this._chats.get(chatId);
    if (cached) return cached;
    // Signal doesn't have a "fetch chat" API — return minimal info
    return { id: chatId, name: chatId };
  }

  getCharLimit() {
    return null; // Signal has no practical message length limit
  }

  getSupportedFeatures() {
    return ['text', 'attachments', 'groups'];
  }

  // --- Registration helpers (one-time setup) ---

  /**
   * Register a phone number with Signal.
   * Call this once, then verify with verifyRegistration().
   * @param {string} [phoneNumber] - Defaults to this.phoneNumber
   * @param {boolean} [captcha] - Use captcha verification
   */
  async register(phoneNumber, captcha = false) {
    const num = phoneNumber || this.phoneNumber;
    const resp = await this._fetch(`/v1/register/${encodeURIComponent(num)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ use_voice: false }),
    });
    const result = await resp.json().catch(() => ({}));
    console.log(`[signal] Registration initiated for ${num}:`, result);
    return result;
  }

  /**
   * Verify registration with SMS code.
   * @param {string} code - Verification code from SMS
   * @param {string} [phoneNumber]
   */
  async verifyRegistration(code, phoneNumber) {
    const num = phoneNumber || this.phoneNumber;
    const resp = await this._fetch(`/v1/register/${encodeURIComponent(num)}/verify/${code}`, {
      method: 'POST',
    });
    const result = await resp.json().catch(() => ({}));
    console.log(`[signal] Verification result for ${num}:`, result);
    return result;
  }

  // --- Internal methods ---

  async _poll() {
    if (this._stopping) return;

    try {
      const resp = await this._fetch(`/v1/receive/${encodeURIComponent(this.phoneNumber)}`, {
        method: 'GET',
      });

      if (resp.ok) {
        const messages = await resp.json();
        if (Array.isArray(messages)) {
          for (const msg of messages) {
            this._handleIncoming(msg);
          }
        }
      }
    } catch (err) {
      // Don't spam logs on connection errors — just retry next cycle
      if (!this._lastPollError || Date.now() - this._lastPollError > 60000) {
        console.error(`[signal] Poll error: ${err.message}`);
        this._lastPollError = Date.now();
      }
    }

    // Schedule next poll
    this._pollTimer = setTimeout(() => this._poll(), this.pollInterval);
  }

  async _acceptMessageRequest(uuid) {
    if (!uuid || this._acceptedContacts?.has(uuid)) return;
    if (!this._acceptedContacts) this._acceptedContacts = new Set();
    try {
      await this._fetch(`/v1/contacts/${encodeURIComponent(this.phoneNumber)}/accept-message-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: uuid }),
      });
      this._acceptedContacts.add(uuid);
      console.log(`[signal] Accepted message request from ${uuid}`);
    } catch (err) {
      // Non-fatal — log and continue
      console.warn(`[signal] Could not accept message request from ${uuid}: ${err.message}`);
    }
  }

  _handleIncoming(raw) {
    // signal-cli-rest-api returns envelope objects
    const envelope = raw.envelope || raw;
    if (!envelope) return;

    // Auto-accept message requests so contacts can add bot to groups
    const senderUuid = envelope.sourceUuid || envelope.source;
    if (senderUuid && !senderUuid.startsWith('+')) {
      this._acceptMessageRequest(senderUuid);
    }

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return; // Skip receipts, typing indicators, etc.

    const text = dataMessage.message;
    if (!text && !dataMessage.attachments?.length) return; // Skip empty messages

    const senderId = envelope.source || envelope.sourceNumber;
    const senderName = envelope.sourceName || senderId;
    const chatId = dataMessage.groupInfo?.groupId || senderId;
    console.log(`[signal] Incoming from ${senderId} (chat: ${chatId}): ${(dataMessage.message || '').substring(0, 50)}`);
    const timestamp = dataMessage.timestamp || envelope.timestamp || Date.now();

    // Process attachments
    const attachments = (dataMessage.attachments || []).map(att => ({
      name: att.filename || `attachment_${att.id}`,
      type: att.contentType || 'application/octet-stream',
      id: att.id,
      size: att.size,
    }));

    // Cache chat info
    this._chats.set(chatId, { id: chatId, name: senderName, lastSeen: Date.now() });

    const normalized = new NormalizedMessage({
      id: String(timestamp),
      platform: 'signal',
      chatId,
      senderId,
      senderName,
      text: text || '',
      attachments,
      timestamp,
      raw,
    });

    this.emit('message', normalized);
  }

  _isGroupId(chatId) {
    // Signal group IDs are base64-encoded, UUIDs are individual users
    // UUID format: 8-4-4-4-12 hex chars with dashes
    if (!chatId) return false;
    if (chatId.startsWith('+')) return false; // phone number
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId)) return false; // UUID = individual
    return chatId.length > 20; // everything else long = group
  }

  async _fetch(path, opts = {}) {
    // Use dynamic import for fetch (Node 18+ has global fetch, but be safe)
    const url = `${this.apiUrl}${path}`;
    return fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(15000), // 15s timeout
    });
  }
}

module.exports = { SignalAdapter };
