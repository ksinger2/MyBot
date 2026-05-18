const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('../atomic-write');
const { readEncryptedJson, writeEncryptedJson } = require('../encrypted-json');

// Persist UUID→phone mappings across restarts so group members are recognized
// even after a bot rebuild wipes the in-memory cache.
//
// Schema v2 shape:
//   { version: 2,
//     byUuid: { "<uuid>": { phone, firstSeen, lastSeen } },
//     byPhone: { "<phone>": ["<uuid>", ...] } }
//
// Phone is the canonical user key; UUID is a lookup aid. A phone may be linked
// to multiple UUIDs over time (e.g., Signal re-registration on a new device),
// and when that happens we only extend byPhone[phone] — we NEVER auto-migrate
// tokens or profiles tied to the old UUID. That is an owner-initiated action.
const UUID_CACHE_FILE = '/app/data/signal-uuid-phone.json';
const UUID_CACHE_DOMAIN = 'mybot-signal-uuid-phone';

function _emptyUuidMap() {
  return { version: 2, byUuid: {}, byPhone: {} };
}

function _loadUuidMap() {
  try {
    const raw = readEncryptedJson(UUID_CACHE_FILE, UUID_CACHE_DOMAIN);
    if (raw && raw.version === 2 && raw.byUuid && raw.byPhone) return raw;
    // Migrate v1 { uuid: phone, ... } → v2
    if (raw && typeof raw === 'object' && !raw.version) {
      const now = Date.now();
      const v2 = _emptyUuidMap();
      for (const [uuid, phone] of Object.entries(raw)) {
        if (!uuid || typeof phone !== 'string') continue;
        v2.byUuid[uuid] = { phone, firstSeen: now, lastSeen: now };
        if (!v2.byPhone[phone]) v2.byPhone[phone] = [];
        if (!v2.byPhone[phone].includes(uuid)) v2.byPhone[phone].push(uuid);
      }
      try { writeEncryptedJson(UUID_CACHE_FILE, v2, UUID_CACHE_DOMAIN); } catch {}
      console.log(`[signal] Migrated UUID map v1 → v2: ${Object.keys(v2.byUuid).length} entries`);
      return v2;
    }
    // Empty or unrecognized — start fresh
    if (!raw || Object.keys(raw).length === 0) return _emptyUuidMap();
    return _emptyUuidMap();
  } catch {
    return _emptyUuidMap();
  }
}

function _persistUuidMap(uuidMap) {
  try {
    writeEncryptedJson(UUID_CACHE_FILE, uuidMap, UUID_CACHE_DOMAIN);
  } catch {}
}

/**
 * Record (or refresh) a UUID→phone mapping in the v2 structure.
 * - Adds firstSeen only on first insertion; always updates lastSeen.
 * - If the phone already has other UUIDs in byPhone, append (don't replace).
 * Returns true if a new uuid entry was created, false if it already existed.
 */
function _recordUuidPhone(uuidMap, uuid, phone) {
  if (!uuid || !phone || typeof phone !== 'string' || !phone.startsWith('+')) return false;
  const now = Date.now();
  let added = false;
  const existing = uuidMap.byUuid[uuid];
  if (!existing) {
    uuidMap.byUuid[uuid] = { phone, firstSeen: now, lastSeen: now };
    added = true;
  } else {
    existing.lastSeen = now;
    // If the phone for this UUID changed (unusual — UUIDs are supposed to be
    // stable per account), update, but this is still just cache. No token
    // migration happens here.
    if (existing.phone !== phone) existing.phone = phone;
  }
  if (!uuidMap.byPhone[phone]) uuidMap.byPhone[phone] = [];
  if (!uuidMap.byPhone[phone].includes(uuid)) uuidMap.byPhone[phone].push(uuid);
  return added;
}

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

/**
 * Redact a phone number for log output. Shows first 2 chars (usually "+1")
 * and last 2 digits, masking the middle: "+1****72". Preserves non-strings
 * and non-E.164 values unchanged so we never mangle a UUID or an object.
 * Only used in log output — data flow continues to carry real numbers.
 */
function _redactPhone(p) {
  if (typeof p !== 'string' || !p.startsWith('+')) return p;
  if (p.length <= 4) return p;
  return p.slice(0, 2) + '****' + p.slice(-2);
}

/**
 * Redact a UUID for log output. Shows first 4 and last 4 characters:
 * "abcd...1234". UUIDs are PII in the same sense phone numbers are.
 * Skips phone numbers (handled by _redactPhone) and short non-PII strings.
 */
function _redactUuid(u) {
  if (typeof u !== 'string' || u.length < 12) return u;
  if (u.startsWith('+')) return u; // phone number — caller should use _redactPhone
  return u.slice(0, 4) + '...' + u.slice(-4);
}

/**
 * Redact either a phone number or UUID — whichever the input looks like.
 * Useful for fields like `senderId`/`recipient` that can be either shape.
 */
function _redactId(id) {
  if (typeof id !== 'string') return id;
  if (id.startsWith('+')) return _redactPhone(id);
  return _redactUuid(id);
}

/**
 * Age-out sweep for /tmp/signal-attachments/. Deletes any file whose mtime
 * is older than 24h. Silent on individual file errors (best-effort GC).
 */
function _cleanupOldAttachments() {
  const dir = '/tmp/signal-attachments';
  try {
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      try {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch { /* skip individual file errors */ }
    }
    if (removed > 0) console.log(`[signal] cleaned up ${removed} stale attachment(s) older than 24h`);
  } catch (err) {
    console.warn(`[signal] attachment cleanup failed: ${err.message}`);
  }
}

class SignalAdapter extends MessagePlatform {
  constructor(opts = {}) {
    super(opts);
    this.platform = 'signal';
    this.apiUrl = (opts.apiUrl || process.env.SIGNAL_API_URL || 'http://signal-api:8080').replace(/\/$/, '');
    this.phoneNumber = opts.phoneNumber || process.env.SIGNAL_PHONE_NUMBER;
    this.pollInterval = opts.pollInterval || parseInt(process.env.SIGNAL_POLL_INTERVAL, 10) || 5000;
    this._pollTimer = null;
    this._cleanupTimer = null;
    this._stopping = false;

    // Track known conversations for chat metadata
    this._chats = new Map(); // chatId → { name, lastSeen }
    // Schema v2 UUID↔phone map (see _loadUuidMap above). Structure:
    //   { version: 2, byUuid: { uuid: {phone, firstSeen, lastSeen} }, byPhone: { phone: [uuid, ...] } }
    this._uuidMap = _loadUuidMap();
    this._uuidToName = new Map();  // UUID → display name (from signal-cli profile)
    this._groups = new Map(); // internal_id → { publicId, name, isMember }
    this._joinedGroups = new Set(); // internal_ids we've already attempted to join
    this._selfUuid = null; // bot's own ACI/PNI — populated by _loadSelfInfo() so
                           // group mention detection can match @-mentions that
                           // identify the bot by UUID rather than phone number
    this._seenMessages = new Map(); // sender+timestamp → Date.now(), evicted after 60s

    // When SIGNAL_USE_WEBHOOK=true, signal-api runs in MODE=json-rpc and pushes
    // incoming messages to /signal/webhook in claude-api. Polling /v1/receive/
    // is then disabled (it returns "Not implemented" in json-rpc mode anyway).
    this.useWebhook = (opts.useWebhook ?? (process.env.SIGNAL_USE_WEBHOOK || '').toLowerCase() === 'true');
  }

  async start() {
    if (!this.phoneNumber) {
      throw new Error('SignalAdapter: phoneNumber is required (set SIGNAL_PHONE_NUMBER env var or pass in opts)');
    }

    // Verify connectivity to signal-cli-rest-api with retry-with-backoff —
    // signal-api may take 30-60s to come up (especially in json-rpc mode where
    // signal-cli has to spawn the daemon). Retry for up to ~2 minutes before
    // giving up. We do NOT bail on persistent failure: if it eventually comes
    // up, we want the adapter to be functional, so we continue past this check
    // and rely on per-call error handling for any remaining issues.
    let connected = false;
    const maxAttempts = 12;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await this._fetch('/v1/about');
        if (resp.ok) {
          const info = await resp.json();
          console.log(`[signal] Connected to signal-cli-rest-api v${info.versions?.['signal-cli'] || 'unknown'} (attempt ${attempt})`);
          connected = true;
          break;
        } else {
          console.warn(`[signal] API responded with ${resp.status} on attempt ${attempt} — retrying`);
        }
      } catch (err) {
        if (attempt === 1 || attempt === maxAttempts) {
          console.warn(`[signal] Cannot reach ${this.apiUrl} (attempt ${attempt}/${maxAttempts}): ${err.message}`);
        }
      }
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, Math.min(10000, 1000 * attempt))); // 1s..10s backoff
      }
    }
    if (!connected) {
      console.error('[signal] Could not reach signal-api after retries — adapter will start anyway and rely on per-call error handling');
    }

    // Load contacts to build UUID→phone mapping
    await this._loadContacts();

    // Resolve the bot's own UUID so group @-mention matching works for clients
    // that reference the bot by ACI rather than phone number. Best-effort —
    // falls back to phone-only matching if the lookup fails.
    await this._loadSelfInfo();

    // Load groups so we know how to address them and which need joining.
    await this._loadGroups();

    // Age-out sweep for downloaded attachments in /tmp. Run immediately so
    // cruft from a previous boot (including whatever was there when this
    // container started) gets cleaned right away, then once per hour while
    // the adapter is alive. Guard against double-register in case start()
    // is called twice.
    _cleanupOldAttachments();
    if (!this._cleanupTimer) {
      this._cleanupTimer = setInterval(_cleanupOldAttachments, 60 * 60 * 1000);
      if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref();
    }

    // Refresh UUID→phone contact mappings every 5 minutes so newly onboarded
    // users (who ran !setup after the bot started) get their UUIDs resolved
    // for group context injection without needing a bot restart.
    if (!this._contactRefreshTimer) {
      this._contactRefreshTimer = setInterval(() => {
        this._loadContacts().catch(() => {});
      }, 5 * 60 * 1000);
      if (typeof this._contactRefreshTimer.unref === 'function') this._contactRefreshTimer.unref();
    }

    // Start inbound message ingestion. In webhook mode the signal-api container
    // POSTs every incoming envelope to /signal/webhook in claude-api, so polling
    // is unnecessary (and would fail anyway — /v1/receive returns "Not implemented"
    // in MODE=json-rpc).
    this._stopping = false;
    if (this.useWebhook) {
      console.log(`[signal] Webhook mode — not polling. Inbound arrives at /signal/webhook for ${_redactPhone(this.phoneNumber)} (${Object.keys(this._uuidMap.byUuid).length} contacts mapped)`);
    } else {
      this._poll();
      console.log(`[signal] Adapter started — polling every ${this.pollInterval}ms for ${_redactPhone(this.phoneNumber)} (${Object.keys(this._uuidMap.byUuid).length} contacts mapped)`);
    }
    this.ready = true;
    this.emit('ready');
  }

  async stop() {
    this._stopping = true;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
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
  /**
   * Reverse-lookup: phone number → UUID. Needed for outgoing @mentions.
   * Returns null if no mapping is known.
   */
  phoneToUuid(phone) {
    if (!phone || !phone.startsWith('+')) return null;
    const uuids = this._uuidMap.byPhone[phone];
    if (uuids && uuids.length > 0) {
      // Prefer the most-recently-seen UUID for this phone
      let best = uuids[0];
      let bestSeen = this._uuidMap.byUuid[best]?.lastSeen || 0;
      for (let i = 1; i < uuids.length; i++) {
        const seen = this._uuidMap.byUuid[uuids[i]]?.lastSeen || 0;
        if (seen > bestSeen) { best = uuids[i]; bestSeen = seen; }
      }
      return best;
    }
    return null;
  }

  /**
   * Return the list of UUIDs ever observed for a phone number (most recent last).
   */
  phoneToUuids(phone) {
    if (!phone || !phone.startsWith('+')) return [];
    return (this._uuidMap.byPhone[phone] || []).slice();
  }

  /**
   * Expose the shared v2 UUID map so external modules (data-recovery) can
   * update it in-place and have the adapter re-persist.
   */
  getUuidMap() {
    return this._uuidMap;
  }

  persistUuidMap() {
    _persistUuidMap(this._uuidMap);
  }

  /**
   * Process @-mention patterns in outgoing text. Resolves `@Name` patterns
   * to proper Signal mentions using the U+FFFC placeholder + mentions array.
   *
   * Two modes:
   *   1. Explicit: caller passes opts.mentions = [{phone, name, uuid}]
   *   2. Auto-detect: scans text for @Name patterns and matches against
   *      known user profiles (requires user-profiles.js)
   *
   * @param {string} text - Message text potentially containing @mentions
   * @param {Object} opts - Options
   * @param {Array}  opts.mentions - Pre-built mentions array [{phone, name, uuid}]
   * @returns {{ text: string, mentions: Array }} Processed text + mentions array
   */
  _buildOutgoingMentions(text, opts = {}) {
    if (!text) return { text, mentions: [] };

    // Build a name→{phone, uuid} lookup from explicit mentions + known profiles
    const nameMap = new Map(); // lowercase name → { phone, uuid }

    // Explicit mentions take priority
    if (opts.mentions && opts.mentions.length > 0) {
      for (const m of opts.mentions) {
        if (m.name) {
          const uuid = m.uuid || this.phoneToUuid(m.phone);
          if (uuid) nameMap.set(m.name.toLowerCase(), { phone: m.phone, uuid });
        }
      }
    }

    // Auto-detect: load known profiles and build name→uuid map
    try {
      const { getAllProfiles } = require('../user-profiles');
      const profiles = getAllProfiles();
      for (const [phone, profile] of Object.entries(profiles)) {
        if (profile.name && !nameMap.has(profile.name.toLowerCase())) {
          const uuid = this.phoneToUuid(phone);
          if (uuid) nameMap.set(profile.name.toLowerCase(), { phone, uuid });
        }
      }
    } catch {}

    if (nameMap.size === 0) return { text, mentions: [] };

    // Find all @Name occurrences in text and replace with U+FFFC
    const mentions = [];
    let processed = text;
    // Sort by name length descending so "Karen Smith" matches before "Karen"
    const names = [...nameMap.keys()].sort((a, b) => b.length - a.length);

    for (const name of names) {
      const { uuid } = nameMap.get(name);
      // Case-insensitive search for @Name (word boundary after @)
      const re = new RegExp(`@(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=[^a-zA-Z]|$)`, 'gi');
      let match;
      // Collect all match positions first (re-scan after each replacement shifts offsets)
      const positions = [];
      while ((match = re.exec(processed)) !== null) {
        positions.push({ start: match.index, fullMatch: match[0], name: match[1] });
      }
      // Replace in reverse order to preserve positions
      for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i];
        processed = processed.substring(0, pos.start) + '\uFFFC' + processed.substring(pos.start + pos.fullMatch.length);
        mentions.push({ start: pos.start, length: 1, uuid });
      }
    }

    // Re-sort mentions by start position (signal-cli expects this)
    mentions.sort((a, b) => a.start - b.start);

    return { text: processed, mentions };
  }

  async sendMessage(chatId, text, opts = {}) {
    // Strip any prefix (e.g. "signal:") and resolve UUID→phone
    const raw = chatId.replace(/^signal:/, '');
    const recipient = this._resolveRecipient(raw);

    // DETERMINISTIC SECRET FILTER — last line of defense before anything reaches
    // the user. Runs on EVERY outgoing message regardless of source.
    if (text) {
      // Block any password/credential patterns that somehow made it through
      text = text.replace(/"password"\s*:\s*"[^"]+"/gi, '"password": "[REDACTED]"');
      text = text.replace(/password\s*[:=]\s*\S+/gi, 'password=[REDACTED]');
      text = text.replace(/"email"\s*:\s*"[^"@]+@[^"]+"/gi, '"email": "[REDACTED]"');
      text = text.replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]{10,}/gi, 'Authorization: Basic [REDACTED]');
      // Block API key patterns
      text = text.replace(/sk-[A-Za-z0-9_\-]{20,}/g, 'sk-[REDACTED]');
      text = text.replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]');
      text = text.replace(/AIzaSy[A-Za-z0-9_\-]{30,}/g, 'AIzaSy[REDACTED]');
      // Block env var dumps
      text = text.replace(/(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PIN)=["']?[^\s"']{8,}/gi, (m) => m.split('=')[0] + '=[REDACTED]');
    }

    // Clean up markdown for Signal (which doesn't render markdown links).
    // Convert [title](url) → "title (url)" for short URLs, or just "title" for long ones.
    // Also add spacing between bullet points for readability.
    if (text) {
      // Convert markdown links: [title](url) → "title (url)" or just the bare URL
      // if title IS the URL. Never strip URLs — users need clickable links.
      text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, title, url) => {
        return title === url ? url : `${title}\n${url}`;
      });
      // Add blank line after each bullet point for breathing room
      text = text.replace(/^(- .+)$/gm, '$1\n');
      // Collapse triple+ newlines back to double
      text = text.replace(/\n{3,}/g, '\n\n');
    }

    // Process @mentions in outgoing text
    const mentionResult = this._buildOutgoingMentions(text, opts);

    const payload = {
      message: mentionResult.text,
      number: this.phoneNumber,
      text_mode: 'normal',
    };

    if (mentionResult.mentions.length > 0) {
      payload.mentions = mentionResult.mentions;
    }

    // bbernhard/signal-cli-rest-api /v2/send takes EVERYTHING via `recipients`.
    // Phone numbers / UUIDs go in raw; group IDs must be wrapped as
    // `group.{base64(internal_id)}` (the API's "public" group form).
    // Inbound messages give us the internal_id; convert it on the way out.
    let sendRecipient = recipient;
    if (this._isGroupId(recipient)) {
      sendRecipient = this._toPublicGroupId(recipient);
    }
    payload.recipients = [sendRecipient];

    console.log(`[signal] Sending to ${_redactId(recipient)}: ${(text || '').substring(0, 50)}...`);

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

  /**
   * Show the real Signal typing indicator (not a fake "..." message).
   * Calls bbernhard's PUT /v1/typing-indicator/{number} which dispatches a
   * proper SignalServiceTypingMessage. Idempotent and best-effort: errors
   * are swallowed because typing indicators are not critical.
   *
   * Signal typing indicators auto-expire after a few seconds, so callers
   * should re-call this on an interval (e.g. every 8s) while busy.
   */
  async sendTyping(chatId) {
    if (!chatId || !this.ready) return;
    const raw = chatId.replace(/^signal:/, '');
    const recipient = this._resolveRecipient(raw);
    // Same recipient format as /v2/send: groups must be wrapped as `group.{base64(internal)}`.
    const sendRecipient = this._isGroupId(recipient) ? this._toPublicGroupId(recipient) : recipient;
    try {
      await this._fetch(`/v1/typing-indicator/${encodeURIComponent(this.phoneNumber)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: sendRecipient }),
      });
    } catch {
      // Best-effort — typing indicators are not critical
    }
  }

  /**
   * Send a read receipt for a message so the sender sees the blue double-check.
   * Best-effort — errors are swallowed because receipts are not critical.
   */
  async sendReadReceipt(senderIdOrUuid, timestamp) {
    if (!senderIdOrUuid || !timestamp || !this.ready) return;
    const recipient = this._resolveRecipient(senderIdOrUuid.replace(/^signal:/, ''));
    // Don't send read receipts for group messages (only DMs)
    if (this._isGroupId(recipient)) return;
    try {
      await this._fetch(`/v1/receipts/${encodeURIComponent(this.phoneNumber)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receipt_type: 'read',
          recipient,
          timestamp,
        }),
      });
    } catch {
      // Best-effort — read receipts are not critical
    }
  }

  /**
   * React to a message in Signal.
   * @param {string} recipient - Phone number or group ID of the conversation
   * @param {string} emoji - Emoji to react with (e.g. '👍')
   * @param {string} targetAuthor - Phone number of the message author being reacted to
   * @param {number} targetTimestamp - Timestamp of the message being reacted to
   * @param {boolean} [remove] - If true, remove the reaction instead of adding it
   */
  async sendReaction(recipient, emoji, targetAuthor, targetTimestamp, remove = false) {
    if (!recipient || !emoji || !targetAuthor || !targetTimestamp || !this.ready) return;
    const resolved = this._resolveRecipient(recipient.replace(/^signal:/, ''));
    try {
      await this._fetch(`/v1/reactions/${encodeURIComponent(this.phoneNumber)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: resolved,
          reaction: emoji,
          target_author: targetAuthor,
          timestamp: targetTimestamp,
          remove,
        }),
      });
    } catch (err) {
      console.warn(`[signal] sendReaction failed: ${err.message}`);
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

  /**
   * Load all groups for this account, building the internal_id → public_id map
   * and auto-joining any groups where we're listed as a pending invite.
   */
  async _loadGroups() {
    try {
      const resp = await this._fetch(`/v1/groups/${encodeURIComponent(this.phoneNumber)}`);
      if (!resp.ok) {
        console.warn(`[signal] Could not list groups: HTTP ${resp.status}`);
        return;
      }
      const groups = await resp.json();
      if (!Array.isArray(groups)) return;

      let pending = 0;
      for (const g of groups) {
        if (!g.internal_id) continue;
        const isMember = Array.isArray(g.members) && g.members.some(m => m === this.phoneNumber);
        const isPending = Array.isArray(g.pending_invites) && g.pending_invites.some(p => p === this.phoneNumber);
        this._groups.set(g.internal_id, {
          publicId: g.id,           // already in `group.{base64}` form
          name: g.name || g.internal_id,
          isMember,
        });
        if (!isMember && isPending && !this._joinedGroups.has(g.internal_id)) {
          pending++;
          this._joinedGroups.add(g.internal_id);
          this._joinGroup(g.id, g.name || g.internal_id, g.internal_id).catch(() => {});
        }
      }
      console.log(`[signal] Loaded ${this._groups.size} group(s); attempting to join ${pending} pending invite(s)`);
    } catch (err) {
      console.warn(`[signal] Could not load groups: ${err.message}`);
    }
  }

  /**
   * Attempt to join a group we've been invited to. Idempotent.
   *
   * NOTE: bbernhard's /v1/groups/.../join endpoint returns 204 (success) even
   * when the underlying signal-cli `updateGroup -g` call fails with "Cannot
   * find service ID for self to accept invite" — the json-rpc error is
   * silently swallowed by the REST wrapper. So we cannot trust the HTTP
   * response. We re-fetch the group list afterward to verify actual membership
   * and only log success if the bot is actually a member now.
   *
   * The "Cannot find service ID for self" error is a known limitation of
   * standalone-registered signal-cli accounts. The only real fix is to
   * onboard the bot as a linked device of a primary phone Signal install.
   */
  async _joinGroup(publicId, name, internalId) {
    try {
      const resp = await this._fetch(`/v1/groups/${encodeURIComponent(this.phoneNumber)}/${encodeURIComponent(publicId)}/join`, {
        method: 'POST',
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.warn(`[signal] Failed to join group (${_redactId(internalId)}): HTTP ${resp.status}`);
        return;
      }
      // Verify actual membership (bbernhard returns 204 even on silent errors)
      const verifyResp = await this._fetch(`/v1/groups/${encodeURIComponent(this.phoneNumber)}/${encodeURIComponent(publicId)}`);
      if (verifyResp.ok) {
        const grp = await verifyResp.json();
        const actuallyMember = (grp.members || []).includes(this.phoneNumber);
        if (actuallyMember) {
          console.log(`[signal] Joined group ${_redactId(internalId)} — confirmed member`);
          if (internalId && this._groups.has(internalId)) {
            this._groups.get(internalId).isMember = true;
          }
        } else {
          console.warn(`[signal] Join call returned 204 for group ${_redactId(internalId)} but bot is still pending invite — likely the "Cannot find service ID for self" signal-cli limitation.`);
        }
      }
    } catch (err) {
      console.warn(`[signal] Error joining group ${_redactId(internalId)}: ${err.message}`);
    }
  }

  /**
   * Join a Signal v2 group via an invite LINK (https://signal.group/#...).
   *
   * This is a fundamentally different code path from "accepting a pending
   * invite" — signal-cli's `joinGroup` method uses the invite key embedded
   * in the URI to add the bot directly as a member, bypassing the
   * `GroupV2Helper.acceptInvite()` call that fails with "Cannot find service
   * ID for self" on standalone-registered accounts.
   *
   * Implementation: bbernhard's REST wrapper does NOT expose this endpoint
   * (only `/join` which calls `updateGroup -g` — the broken path). So we
   * shell out via `docker exec` into the signal-api container and connect
   * directly to signal-cli's JSON-RPC daemon on localhost:6001 via Python.
   * The docker socket is already mounted in claude-api for this exact kind
   * of cross-container ops.
   */
  async joinGroupByLink(uri) {
    if (!uri || typeof uri !== 'string') throw new Error('joinGroupByLink: uri required');
    if (!/^https?:\/\/signal\.group\/#/.test(uri)) {
      throw new Error('Not a Signal group invite link (should start with https://signal.group/#)');
    }
    const containerName = process.env.SIGNAL_API_CONTAINER || 'mybot-signal-api-1';
    const account = this.phoneNumber;
    // Inline Python that connects to the local signal-cli JSON-RPC daemon.
    // We pass account + uri via env vars to avoid quoting issues.
    const pyScript = [
      'import socket, json, os, sys',
      's = socket.create_connection(("127.0.0.1", 6001), timeout=30)',
      'req = json.dumps({"jsonrpc":"2.0","id":"jgl","method":"joinGroup","params":{"account":os.environ["ACCOUNT"],"uri":os.environ["URI"]}}) + "\\n"',
      's.sendall(req.encode())',
      'buf = b""',
      'while b"\\n" not in buf:',
      '    chunk = s.recv(4096)',
      '    if not chunk: break',
      '    buf += chunk',
      'sys.stdout.write(buf.decode().strip())',
    ].join('\n');

    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
      const proc = spawn('docker', [
        'exec',
        '-i',
        '-e', `ACCOUNT=${account}`,
        '-e', `URI=${uri}`,
        containerName,
        'python3', '-c', pyScript,
      ]);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', err => reject(err));
      proc.on('close', code => {
        if (code !== 0) {
          return reject(new Error(`docker exec failed (code ${code}): ${stderr || stdout}`));
        }
        try {
          const resp = JSON.parse(stdout);
          if (resp.error) {
            return reject(new Error(resp.error.message || 'JSON-RPC error'));
          }
          resolve(resp.result || {});
        } catch (e) {
          reject(new Error(`Failed to parse JSON-RPC response: ${stdout.substring(0, 300)}`));
        }
      });
    });
  }

  /**
   * Convert an internal group ID (base64, no prefix) into the public form
   * `group.{base64(internal_id)}` that /v2/send expects in `recipients`.
   * Falls back to a fresh base64-wrap if the group isn't in the cache.
   */
  _toPublicGroupId(internalId) {
    const cached = this._groups.get(internalId);
    if (cached?.publicId) return cached.publicId;
    // Fresh wrap — works even before _loadGroups has populated the cache.
    return 'group.' + Buffer.from(internalId, 'utf-8').toString('base64');
  }

  /**
   * Resolve this.phoneNumber → this._selfUuid via /v1/identities/{number}.
   *
   * bbernhard's /v1/identities endpoint returns every identity signal-cli has
   * seen for the account — including the account's OWN entry, which carries
   * its ACI in the `uuid` field. We find the row where `number === phoneNumber`
   * and cache its UUID so the Signal mention detector in bot.js can match
   * @-mentions that identify the bot by UUID instead of phone number.
   *
   * Best-effort — any failure just leaves _selfUuid null and mention detection
   * falls back to phone-number match.
   */
  async _loadSelfInfo() {
    try {
      const resp = await this._fetch(`/v1/identities/${encodeURIComponent(this.phoneNumber)}`);
      if (!resp.ok) {
        console.warn(`[signal] Could not load self identity: HTTP ${resp.status}`);
        return;
      }
      const identities = await resp.json();
      if (!Array.isArray(identities)) return;
      const selfRow = identities.find(i => i && i.number === this.phoneNumber && i.uuid);
      if (selfRow) {
        this._selfUuid = selfRow.uuid;
        // Also seed the UUID→phone cache with the self mapping so replies
        // that come back addressed by UUID resolve correctly.
        _recordUuidPhone(this._uuidMap, selfRow.uuid, this.phoneNumber);
        _persistUuidMap(this._uuidMap);
        console.log(`[signal] Self UUID resolved: ${this._selfUuid}`);
      } else {
        console.warn(`[signal] No identity row found for self (${this.phoneNumber}) — UUID mention detection disabled`);
      }
    } catch (err) {
      console.warn(`[signal] Could not load self info: ${err.message}`);
    }
  }

  async _loadContacts() {
    try {
      const resp = await this._fetch(`/v1/contacts/${encodeURIComponent(this.phoneNumber)}`);
      if (resp.ok) {
        const contacts = await resp.json();
        for (const c of contacts) {
          if (c.uuid && c.number) {
            _recordUuidPhone(this._uuidMap, c.uuid, c.number);
          }
          // Cache profile display names for UUID→name resolution (even without phone)
          if (c.uuid) {
            const displayName = c.profile?.given_name || c.name || c.profile_name || null;
            if (displayName) this._uuidToName.set(c.uuid, displayName);
          }
        }
        _persistUuidMap(this._uuidMap);
        console.log(`[signal] Loaded ${Object.keys(this._uuidMap.byUuid).length} UUID→phone, ${this._uuidToName.size} UUID→name mappings`);
      }
    } catch (err) {
      console.warn(`[signal] Could not load contacts: ${err.message}`);
    }
  }

  /**
   * Resolve a UUID to a phone number. Falls back to UUID if no mapping.
   */
  _resolveRecipient(uuidOrPhone) {
    if (!uuidOrPhone) return uuidOrPhone;
    if (uuidOrPhone.startsWith('+')) return uuidOrPhone; // already a phone number
    return this._uuidMap.byUuid[uuidOrPhone]?.phone || uuidOrPhone;
  }

  /**
   * Resolve a UUID to a display name. Checks: signal-cli profile name cache,
   * then user-profiles (bot-side), then falls back to null.
   */
  resolveUuidToName(uuid) {
    if (!uuid) return null;
    // Check signal-cli profile name cache
    const cached = this._uuidToName.get(uuid);
    if (cached) return cached;
    // Try UUID→phone→profile
    const phone = this._uuidMap.byUuid[uuid]?.phone;
    if (phone) {
      try {
        const { getProfile } = require('../user-profiles');
        const p = getProfile(phone);
        if (p?.name) return p.name;
      } catch {}
    }
    return null;
  }

  async _acceptMessageRequest(uuid) {
    if (!uuid) return;
    if (!this._acceptedContacts) this._acceptedContacts = new Set();
    if (this._acceptedContacts.has(uuid)) return;
    this._acceptedContacts.add(uuid); // add before async call to prevent races
    try {
      await this._fetch(`/v1/contacts/${encodeURIComponent(this.phoneNumber)}/accept-message-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: uuid }),
      });
      console.log(`[signal] Accepted message request from ${_redactUuid(uuid)}`);
    } catch (err) {
      // Non-fatal — log and continue
      console.warn(`[signal] Could not accept message request from ${_redactUuid(uuid)}: ${err.message}`);
    }
  }

  async _handleIncoming(raw) {
    // signal-cli-rest-api returns envelope objects
    const envelope = raw.envelope || raw;
    if (!envelope) return;

    // Dedup: signal-api can deliver the same envelope more than once (webhook
    // retry, polling overlap, etc.). Key on sender+timestamp — unique per msg.
    const ts = envelope.dataMessage?.timestamp || envelope.timestamp;
    const src = envelope.sourceUuid || envelope.sourceNumber || envelope.source || '';
    if (ts && src) {
      const dedupKey = `${src}:${ts}`;
      if (this._seenMessages.has(dedupKey)) return;
      this._seenMessages.set(dedupKey, Date.now());
      if (this._seenMessages.size > 200) {
        const cutoff = Date.now() - 60000;
        for (const [k, v] of this._seenMessages) {
          if (v < cutoff) this._seenMessages.delete(k);
        }
      }
    }

    // Auto-accept message requests so contacts can add bot to groups
    const senderUuid = envelope.sourceUuid || envelope.source;
    if (senderUuid && !senderUuid.startsWith('+')) {
      this._acceptMessageRequest(senderUuid);
    }

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return; // Skip receipts, typing indicators, etc.

    const text = dataMessage.message;
    // Handle "delete for everyone" — cancel any queued/running task that originated from this message
    if (dataMessage.remoteDelete) {
      const deletedTs = dataMessage.remoteDelete.timestamp;
      const senderPhone2 = envelope.sourceNumber || this._resolveRecipient(envelope.sourceUuid || envelope.source);
      const groupId2 = dataMessage.groupInfo?.groupId;
      const chatId2 = groupId2 || senderPhone2 || (envelope.sourceUuid || envelope.source);
      console.log(`[signal] Remote delete for timestamp ${deletedTs} in chat ${chatId2}`);
      this.emit('messageDelete', { chatId: chatId2, deletedTimestamp: deletedTs });
      return;
    }

    // Handle emoji reactions (👍/👎 etc.) — these have no text/attachments
    if (dataMessage.reaction) {
      const r = dataMessage.reaction;
      const senderPhone2 = envelope.sourceNumber || this._resolveRecipient(senderUuid);
      const senderId2 = senderPhone2 || senderUuid;
      const groupId2 = dataMessage.groupInfo?.groupId;
      const chatId2 = groupId2 || senderPhone2 || senderUuid;
      console.log(`[signal] Reaction ${r.emoji} from ${_redactId(senderId2)} on ts=${r.targetSentTimestamp} remove=${r.isRemove}`);
      this.emit('reaction', {
        chatId: chatId2,
        senderId: senderId2,
        emoji: r.emoji,
        targetTimestamp: r.targetSentTimestamp,
        isRemove: !!r.isRemove,
      });
      return;
    }

    if (!text && !dataMessage.attachments?.length) return; // Skip empty messages

    // Resolve UUID→phone so replies go to the same chat thread
    const senderPhone = envelope.sourceNumber || this._resolveRecipient(senderUuid);
    const senderId = senderPhone || senderUuid;
    const senderName = envelope.sourceName || senderId;
    const groupInternalId = dataMessage.groupInfo?.groupId;
    const chatId = groupInternalId || senderPhone || senderUuid;

    // If this is a group we don't know about (or aren't a member of), refresh
    // the group list — it's likely a fresh invite. _loadGroups will auto-join
    // any pending invites it finds.
    if (groupInternalId) {
      const cached = this._groups.get(groupInternalId);
      if (!cached || !cached.isMember) {
        this._loadGroups().catch(() => {});
      }
    }
    // Cache any new UUID→phone mapping we discover — persist to disk so it
    // survives bot restarts (in-memory map alone gets wiped on every rebuild).
    if (senderUuid && envelope.sourceNumber) {
      const wasNew = _recordUuidPhone(this._uuidMap, senderUuid, envelope.sourceNumber);
      // Always update lastSeen (cheap), but only persist + log on new entry or
      // if this is a phone that gained a new UUID (cache-only — no token migration).
      if (wasNew) {
        _persistUuidMap(this._uuidMap);
        console.log(`[signal] Learned UUID→phone: ${_redactUuid(senderUuid)} → ${_redactPhone(envelope.sourceNumber)}`);
      } else {
        _persistUuidMap(this._uuidMap); // refresh lastSeen on disk
      }
    }
    // Even when envelope.sourceNumber is absent (newer Signal clients omit it),
    // if senderId resolved to a phone number from the UUID cache, store the
    // reverse mapping so future group lookups can find this user by UUID.
    if (senderUuid && senderId && senderId !== senderUuid && senderId.startsWith('+')) {
      if (!this._uuidMap.byUuid[senderUuid]) {
        _recordUuidPhone(this._uuidMap, senderUuid, senderId);
        _persistUuidMap(this._uuidMap);
        console.log(`[signal] Stored UUID→phone from resolved sender: ${_redactUuid(senderUuid)} → ${_redactPhone(senderId)}`);
      }
    }
    console.log(`[signal] Incoming from ${_redactId(senderId)} (phone: ${_redactPhone(senderPhone)}, uuid: ${_redactUuid(senderUuid)}, chat: ${_redactId(chatId)}): ${(dataMessage.message || '').substring(0, 50)}${dataMessage.attachments?.length ? ` [${dataMessage.attachments.length} attachment(s)]` : ''}`);
    const timestamp = dataMessage.timestamp || envelope.timestamp || Date.now();

    // Download attachments to a local temp dir so Claude can Read them. The
    // signal-api exposes raw bytes at GET /v1/attachments/{id}; we save under
    // /tmp/signal-attachments/{ts}-{filename} and pass the local path through.
    // Without this, Claude only sees an attachment id and cannot inspect the
    // file — which is the bug the user reported ("sent an image, bot couldn't
    // receive it").
    const attachments = [];
    for (const att of (dataMessage.attachments || [])) {
      const attMeta = {
        name: att.filename || `attachment_${att.id}`,
        type: att.contentType || 'application/octet-stream',
        id: att.id,
        size: att.size,
        localPath: null,
      };
      try {
        const localPath = await this._downloadAttachment(att.id, attMeta.name, attMeta.type);
        if (localPath) {
          attMeta.localPath = localPath;
        }
      } catch (err) {
        console.warn(`[signal] Failed to download attachment ${att.id}: ${err.message}`);
      }
      attachments.push(attMeta);
    }

    // Cache chat info
    this._chats.set(chatId, { id: chatId, name: senderName, lastSeen: Date.now() });

    // Extract mentions in a normalized form so the consumer can check whether
    // the bot was @mentioned in a group. signal-cli mention objects vary in
    // shape — sometimes only `uuid` is set, sometimes only `number`, sometimes
    // both. We pass through whatever the envelope had.
    const mentions = (dataMessage.mentions || []).map(m => ({
      number: m.number || (m.uuid ? this._resolveRecipient(m.uuid) : null) || null,
      uuid: m.uuid || null,
      name: m.name || null,
      start: m.start,
      length: m.length,
    }));
    // Resolve UUID-only mentions to phone numbers via the contact cache,
    // then look up profile names so @mentions render as real names in text
    for (const m of mentions) {
      if (!m.number && m.uuid) {
        const resolved = this._resolveRecipient(m.uuid);
        if (resolved && resolved.startsWith('+')) m.number = resolved;
      }
      // If we still have no name, try signal-cli profile cache then user-profiles
      if (!m.name && m.uuid) {
        m.name = this.resolveUuidToName(m.uuid) || null;
      }
      if (!m.name && m.number && m.number.startsWith('+')) {
        try {
          const { getProfile } = require('../user-profiles');
          const profile = getProfile(m.number);
          if (profile && profile.name) m.name = profile.name;
        } catch {}
      }
    }

    const normalized = new NormalizedMessage({
      id: String(timestamp),
      platform: 'signal',
      chatId,
      senderId,
      senderName,
      text: text || '',
      attachments,
      mentions,
      timestamp,
      raw,
    });

    this.emit('message', normalized);
  }

  /**
   * Download an attachment from signal-api and save it to /tmp.
   * Returns the local file path, or null on failure.
   */
  async _downloadAttachment(attachmentId, filename, contentType) {
    if (!attachmentId) return null;

    const dir = '/tmp/signal-attachments';
    fs.mkdirSync(dir, { recursive: true });

    // Pick an extension if filename has none — helps Claude figure out file type
    let safeName = (filename || `att_${attachmentId}`).replace(/[^\w.\-]/g, '_');
    if (!path.extname(safeName) && contentType) {
      const extMap = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
        'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif',
        'video/mp4': '.mp4', 'video/quicktime': '.mov',
        'audio/aac': '.aac', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
        'application/pdf': '.pdf',
      };
      const ext = extMap[contentType];
      if (ext) safeName += ext;
    }
    const localPath = path.join(dir, `${Date.now()}_${safeName}`);

    const resp = await this._fetch(`/v1/attachments/${encodeURIComponent(attachmentId)}`);
    if (!resp.ok) {
      throw new Error(`signal-api returned ${resp.status} for attachment ${attachmentId}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(localPath, buf);
    console.log(`[signal] Downloaded attachment ${attachmentId} → ${localPath} (${buf.length} bytes)`);
    return localPath;
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
