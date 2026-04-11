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
const fs = require('fs');
const path = require('path');

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
    this._uuidToPhone = new Map(); // UUID → phone number cache
    this._groups = new Map(); // internal_id → { publicId, name, isMember }
    this._joinedGroups = new Set(); // internal_ids we've already attempted to join

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

    // Start inbound message ingestion. In webhook mode the signal-api container
    // POSTs every incoming envelope to /signal/webhook in claude-api, so polling
    // is unnecessary (and would fail anyway — /v1/receive returns "Not implemented"
    // in MODE=json-rpc).
    this._stopping = false;
    if (this.useWebhook) {
      console.log(`[signal] Webhook mode — not polling. Inbound arrives at /signal/webhook for ${this.phoneNumber} (${this._uuidToPhone.size} contacts mapped)`);
    } else {
      this._poll();
      console.log(`[signal] Adapter started — polling every ${this.pollInterval}ms for ${this.phoneNumber} (${this._uuidToPhone.size} contacts mapped)`);
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
  async sendMessage(chatId, text, opts = {}) {
    // Strip any prefix (e.g. "signal:") and resolve UUID→phone
    const raw = chatId.replace(/^signal:/, '');
    const recipient = this._resolveRecipient(raw);

    const payload = {
      message: text,
      number: this.phoneNumber,
      text_mode: 'normal',
    };

    // bbernhard/signal-cli-rest-api /v2/send takes EVERYTHING via `recipients`.
    // Phone numbers / UUIDs go in raw; group IDs must be wrapped as
    // `group.{base64(internal_id)}` (the API's "public" group form).
    // Inbound messages give us the internal_id; convert it on the way out.
    let sendRecipient = recipient;
    if (this._isGroupId(recipient)) {
      sendRecipient = this._toPublicGroupId(recipient);
    }
    payload.recipients = [sendRecipient];

    console.log(`[signal] Sending to ${_redactId(recipient)}: ${text.substring(0, 50)}...`);

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
        console.warn(`[signal] Failed to join group "${name}" (${publicId}): HTTP ${resp.status} ${errText.substring(0, 200)}`);
        return;
      }
      // Verify actual membership (bbernhard returns 204 even on silent errors)
      const verifyResp = await this._fetch(`/v1/groups/${encodeURIComponent(this.phoneNumber)}/${encodeURIComponent(publicId)}`);
      if (verifyResp.ok) {
        const grp = await verifyResp.json();
        const actuallyMember = (grp.members || []).includes(this.phoneNumber);
        if (actuallyMember) {
          console.log(`[signal] Joined group "${name}" — confirmed member`);
          if (internalId && this._groups.has(internalId)) {
            this._groups.get(internalId).isMember = true;
          }
        } else {
          console.warn(`[signal] Join call returned 204 for "${name}" but bot is still pending invite — likely the "Cannot find service ID for self" signal-cli limitation. Group will be unreachable until the account is re-linked as a linked device.`);
        }
      }
    } catch (err) {
      console.warn(`[signal] Error joining group "${name}": ${err.message}`);
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

  async _loadContacts() {
    try {
      const resp = await this._fetch(`/v1/contacts/${encodeURIComponent(this.phoneNumber)}`);
      if (resp.ok) {
        const contacts = await resp.json();
        for (const c of contacts) {
          if (c.uuid && c.number) {
            this._uuidToPhone.set(c.uuid, c.number);
          }
        }
        console.log(`[signal] Loaded ${this._uuidToPhone.size} UUID→phone mappings`);
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
    return this._uuidToPhone.get(uuidOrPhone) || uuidOrPhone;
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

    // Auto-accept message requests so contacts can add bot to groups
    const senderUuid = envelope.sourceUuid || envelope.source;
    if (senderUuid && !senderUuid.startsWith('+')) {
      this._acceptMessageRequest(senderUuid);
    }

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return; // Skip receipts, typing indicators, etc.

    const text = dataMessage.message;
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
    // Cache any new UUID→phone mapping we discover
    if (senderUuid && envelope.sourceNumber && !this._uuidToPhone.has(senderUuid)) {
      this._uuidToPhone.set(senderUuid, envelope.sourceNumber);
      console.log(`[signal] Learned UUID→phone: ${_redactUuid(senderUuid)} → ${_redactPhone(envelope.sourceNumber)}`);
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
      number: m.number || null,
      uuid: m.uuid || null,
      name: m.name || null,
      start: m.start,
      length: m.length,
    }));

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
