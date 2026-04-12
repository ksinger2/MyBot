const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
// L5: cap default JSON body size at 1mb. The per-route /signal/webhook override
// (5mb) still applies because it's mounted locally on that route.
app.use(express.json({ limit: '1mb' }));

// ── HTML escape helper (used for CSRF token injection in /setup) ─────────────
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── L7: CSRF tokens for /setup/:userId form ──────────────────────────────────
// Map<userId, { token, expiresAt }> — GET issues, POST verifies and deletes.
const _setupCsrfTokens = new Map();
const SETUP_CSRF_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── F2: ephemeral access tokens for /setup/:userId ──────────────────────────
// Map<token, { userId, expiresAt }> — single-use, 30min TTL. The bot requests
// a token via POST /internal/setup-token and DMs the user a URL with ?t=<token>.
const _setupAccessTokens = new Map();
const SETUP_ACCESS_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── M2 + L7: periodic cleanup intervals ──────────────────────────────────────
// Module-level guard so `require.cache` re-entry (hot reload, test harness)
// doesn't register duplicate intervals.
if (!global.__mybotServerIntervals) {
  global.__mybotServerIntervals = true;

  // M2: sweep stale /tmp/imagine_* files every hour. Anything older than 2h
  // gets removed. Never crash the process if this fails.
  setInterval(() => {
    try {
      const now = Date.now();
      const maxAgeMs = 2 * 60 * 60 * 1000; // 2 hours
      const dir = '/tmp';
      let removed = 0;
      const entries = fs.readdirSync(dir);
      for (const name of entries) {
        if (!name.startsWith('imagine_')) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (now - st.mtimeMs > maxAgeMs) {
            fs.unlinkSync(full);
            removed++;
          }
        } catch { /* ignore per-file errors */ }
      }
      if (removed > 0) {
        console.log(`[imagine-cleanup] removed ${removed} stale file(s)`);
      }
    } catch (err) {
      console.error('[imagine-cleanup] sweep failed:', err.message);
    }
  }, 60 * 60 * 1000).unref();

  // L7 + F2: sweep expired CSRF tokens and setup access tokens every hour.
  setInterval(() => {
    try {
      const now = Date.now();
      let expired = 0;
      for (const [uid, entry] of _setupCsrfTokens.entries()) {
        if (!entry || entry.expiresAt <= now) {
          _setupCsrfTokens.delete(uid);
          expired++;
        }
      }
      // F2: also sweep expired setup access tokens
      for (const [tok, entry] of _setupAccessTokens.entries()) {
        if (!entry || entry.expiresAt <= now) {
          _setupAccessTokens.delete(tok);
          expired++;
        }
      }
      if (expired > 0) {
        console.log(`[setup-tokens] expired ${expired} stale token(s)`);
      }
    } catch (err) {
      console.error('[setup-tokens] sweep failed:', err.message);
    }
  }, 60 * 60 * 1000).unref();
}

// ── Security: shared-secret auth for internal routes ────────────────────────
// Every mutating/sensitive endpoint (/ask, /imagine, /remind, /rebuild, …) is
// gated by a shared secret supplied in the X-Internal-Token header (or the
// ?token= query string for /signal/webhook, where bbernhard's JSON-RPC
// forwarder cannot inject custom headers).
//
// The secret comes from INTERNAL_API_TOKEN in the environment. If it is unset
// we REFUSE every authenticated request with 503 — we never fail open.
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || '';
if (!INTERNAL_API_TOKEN) {
  console.error('[security] WARNING: INTERNAL_API_TOKEN not set — all authenticated routes will be unreachable');
}

// Constant-time string compare (F12: simplified — length-equal inputs go
// straight to timingSafeEqual; length mismatch returns false immediately,
// which is fine because the length itself is not secret for random tokens).
function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// F14: hard-cap helper for in-memory maps. Evicts oldest entries (FIFO via
// insertion order) when the map exceeds maxSize. Rate-limited warning log.
function _capMap(map, maxSize, label) {
  if (map.size <= maxSize) return;
  const excess = map.size - maxSize;
  const iter = map.keys();
  for (let i = 0; i < excess; i++) {
    map.delete(iter.next().value);
  }
  const now = Date.now();
  if (!_capMap._lastWarn || now - _capMap._lastWarn > 60000) {
    _capMap._lastWarn = now;
    console.warn(`[security] ${label} map overflow — evicted ${excess} oldest entries (cap: ${maxSize})`);
  }
}

function requireInternalToken(req, res, next) {
  if (!INTERNAL_API_TOKEN) {
    return res.status(503).json({ error: 'server misconfigured: INTERNAL_API_TOKEN not set' });
  }
  const supplied = req.get('X-Internal-Token') || '';
  if (!safeTokenEqual(supplied, INTERNAL_API_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// (escapeHtml is defined above near the CSRF helpers — used by /setup XSS escapes
// and by the CSRF token injection.)

app.post('/ask', requireInternalToken, (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', 'sonnet',
    '--dangerously-skip-permissions',
    '--no-session-persistence'
  ];

  const child = spawn('claude', args, {
    env: {
      HOME: '/home/node', CI: 'true',
      PATH: process.env.PATH,
      LANG: process.env.LANG || 'en_US.UTF-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const timeout = setTimeout(() => {
    child.kill();
    res.status(504).json({ error: 'Claude CLI timed out' });
  }, 120000);

  child.on('close', (code) => {
    clearTimeout(timeout);
    if (code !== 0) {
      console.error('Claude CLI error, code:', code);
      if (stderr) console.error('stderr:', stderr);
      return res.status(500).json({ error: `CLI exited with code ${code}` });
    }

    try {
      const parsed = JSON.parse(stdout);
      res.json({ response: parsed.result || parsed.text || stdout.trim() });
    } catch {
      res.json({ response: stdout.trim() });
    }
  });
});

// Internal image generation endpoint — called by Claude CLI via curl
app.post('/imagine', requireInternalToken, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'No OPENAI_API_KEY configured' });

  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'low',
    });
    const base64 = response.data[0].b64_json;
    const buffer = Buffer.from(base64, 'base64');
    const imgPath = `/tmp/imagine_${Date.now()}.png`;
    fs.writeFileSync(imgPath, buffer);
    res.json({ path: imgPath, prompt });
  } catch (err) {
    console.error('Image generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Internal reminder endpoint — creates a Google Calendar event as a reminder
// Called by Claude CLI via curl when user asks "remind me..."
app.post('/remind', requireInternalToken, async (req, res) => {
  const { title, datetime, duration_minutes, discord_user_id, description } = req.body;
  if (!title || !datetime || !discord_user_id) {
    return res.status(400).json({ error: 'title, datetime (ISO 8601), and discord_user_id are required' });
  }

  try {
    const googleAuth = require('./google-auth');
    const calendar = await googleAuth.getCalendarClient(discord_user_id);
    if (!calendar) {
      return res.status(400).json({ error: 'User has not connected Google Calendar. Tell them to run !connect first.' });
    }

    const startTime = new Date(datetime);
    const durationMs = (duration_minutes || 15) * 60 * 1000;
    const endTime = new Date(startTime.getTime() + durationMs);

    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: title,
        description: description || `Reminder set via Discord bot`,
        start: { dateTime: startTime.toISOString() },
        end: { dateTime: endTime.toISOString() },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 0 },
            { method: 'popup', minutes: 5 },
          ],
        },
      },
    });

    res.json({
      success: true,
      event_id: event.data.id,
      title,
      start: startTime.toISOString(),
      end: endTime.toISOString(),
      link: event.data.htmlLink,
    });
  } catch (err) {
    console.error('[remind] Error creating reminder:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Group event creation endpoint ────────────────────────────────────────────
// Creates a calendar event on one or more users' calendars. Used by Claude in
// group chats to coordinate events (concerts, dinners, hangouts). When an event
// is created in a group context, it's also stored as a "pending event" so that
// subsequent "I'm in" messages can reference it without session continuity.
//
// Pending events expire after 24 hours and are stored in-memory (lost on restart,
// which is fine — they're short-lived coordination state, not durable data).
const _pendingGroupEvents = new Map(); // chatId → { title, datetime, end_datetime, location, description, createdAt, createdBy, attendees }
const PENDING_EVENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PENDING_EVENTS_FILE = path.join('/app/data', 'pending-events.json');

// Load persisted pending events on startup
try {
  if (fs.existsSync(PENDING_EVENTS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(PENDING_EVENTS_FILE, 'utf-8'));
    const now = Date.now();
    for (const [chatId, ev] of Object.entries(saved)) {
      if (now - ev.createdAt < PENDING_EVENT_TTL_MS) {
        _pendingGroupEvents.set(chatId, ev);
      }
    }
    console.log(`[events] Loaded ${_pendingGroupEvents.size} pending event(s) from disk`);
  }
} catch (err) {
  console.warn(`[events] Could not load pending events: ${err.message}`);
}

function _savePendingEvents() {
  try {
    const obj = Object.fromEntries(_pendingGroupEvents);
    fs.writeFileSync(PENDING_EVENTS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.warn(`[events] Could not save pending events: ${err.message}`);
  }
}

// Sweep expired pending events every hour
if (!global.__mybotPendingEventSweeper) {
  global.__mybotPendingEventSweeper = true;
  setInterval(() => {
    const now = Date.now();
    let swept = false;
    for (const [chatId, ev] of _pendingGroupEvents.entries()) {
      if (now - ev.createdAt > PENDING_EVENT_TTL_MS) {
        _pendingGroupEvents.delete(chatId);
        swept = true;
      }
    }
    if (swept) _savePendingEvents();
  }, 60 * 60 * 1000).unref();
}

app.post('/event', requireInternalToken, async (req, res) => {
  const { title, datetime, end_datetime, duration_minutes, location, description, user_ids, chat_id } = req.body;
  if (!title || !datetime || !user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
    return res.status(400).json({ error: 'title, datetime (ISO 8601), and user_ids (array of phone numbers or Discord IDs) are required' });
  }

  const googleAuth = require('./google-auth');
  const userTokens = require('./user-tokens');

  const startTime = new Date(datetime);
  const endDt = end_datetime ? new Date(end_datetime) : null;
  const durationMs = (duration_minutes || 120) * 60 * 1000;
  const endTime = endDt || new Date(startTime.getTime() + durationMs);

  // Gather emails of all connected users for the attendees list
  const attendeeEmails = [];
  for (const uid of user_ids) {
    const tok = userTokens.getToken(uid);
    if (tok?.email) attendeeEmails.push(tok.email);
  }

  const created = [];
  const failed = [];

  for (const userId of user_ids) {
    const calendar = await googleAuth.getCalendarClient(userId);
    if (!calendar) {
      failed.push({ userId, error: 'not_connected — tell them to run !connect or !setup to link Google Calendar' });
      continue;
    }
    try {
      const event = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: title,
          description: description || '',
          location: location || undefined,
          start: { dateTime: startTime.toISOString() },
          end: { dateTime: endTime.toISOString() },
          attendees: attendeeEmails.map(email => ({ email })),
        },
      });
      const tok = userTokens.getToken(userId);
      created.push({ userId, email: tok?.email || 'unknown', eventId: event.data.id });
    } catch (err) {
      console.error(`[event] create error for ${userId}:`, err.message);
      failed.push({ userId, error: err.message });
    }
  }

  // Store as pending event for the group so "I'm in" works later
  if (chat_id) {
    _pendingGroupEvents.set(chat_id, {
      title,
      datetime: startTime.toISOString(),
      end_datetime: endTime.toISOString(),
      location: location || null,
      description: description || null,
      createdAt: Date.now(),
      createdBy: user_ids[0],
      attendees: created.map(c => c.userId),
    });
    _savePendingEvents();
  }

  res.json({ created, failed, pending_stored: !!chat_id });
});

// Expose pending events for bot.js to inject into group context.
// Set on both app.locals (for internal routes) and global (for bot.js,
// which can't require server.js without a circular dependency).
app.locals.getPendingEvent = (chatId) => _pendingGroupEvents.get(chatId) || null;
global.__mybotGetPendingEvent = app.locals.getPendingEvent;

// Let the bot add a user to a pending event without re-specifying all details
app.post('/event/join', requireInternalToken, async (req, res) => {
  const { chat_id, user_id } = req.body;
  if (!chat_id || !user_id) {
    return res.status(400).json({ error: 'chat_id and user_id required' });
  }

  const pending = _pendingGroupEvents.get(chat_id);
  if (!pending) {
    return res.status(404).json({ error: 'No pending event for this chat. Create one with /event first.' });
  }

  const googleAuth = require('./google-auth');
  const userTokens = require('./user-tokens');

  const calendar = await googleAuth.getCalendarClient(user_id);
  if (!calendar) {
    return res.status(400).json({ error: 'User has not connected Google Calendar. Tell them to run !connect or !setup first.' });
  }

  // Gather all existing + new attendee emails
  const allAttendees = [...new Set([...pending.attendees, user_id])];
  const attendeeEmails = [];
  for (const uid of allAttendees) {
    const tok = userTokens.getToken(uid);
    if (tok?.email) attendeeEmails.push(tok.email);
  }

  try {
    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: pending.title,
        description: pending.description || '',
        location: pending.location || undefined,
        start: { dateTime: pending.datetime },
        end: { dateTime: pending.end_datetime },
        attendees: attendeeEmails.map(email => ({ email })),
      },
    });

    // Update pending event attendees list
    if (!pending.attendees.includes(user_id)) {
      pending.attendees.push(user_id);
      _savePendingEvents();
    }
    const tok = userTokens.getToken(user_id);

    res.json({
      success: true,
      userId: user_id,
      email: tok?.email || 'unknown',
      eventId: event.data.id,
      event_title: pending.title,
      event_datetime: pending.datetime,
    });
  } catch (err) {
    console.error(`[event/join] error for ${user_id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Self-rebuild endpoint ────────────────────────────────────────────────────
// Single sanctioned path for the bot to rebuild itself. Claude is told via the
// system prompt to call this instead of running docker commands directly.
//
// Safety steps:
//   1. Syntax-check every .js file in /workspace/MyBot/claude-api before doing
//      anything destructive. Reject the rebuild if anything fails to parse.
//   2. Flush all pending channel-state writes so we don't lose anything.
//   3. Mark every busy channel with a "wantsRestartNotification" flag so the
//      next process can let users know "I went down — resend if you still need it".
//   4. Spawn the rebuild as a fully-detached background process via nohup so
//      that when docker compose stops THIS container, the spawn keeps going on
//      the host's docker socket and replaces us with the new image.
//
// We respond to the HTTP request BEFORE the rebuild starts so Claude gets a
// confirmation it can announce to the user before the container disappears.
app.post('/rebuild', requireInternalToken, async (req, res) => {
  const { execSync } = require('child_process');

  const APP_DIR = '/workspace/MyBot/claude-api';
  const COMPOSE_FILE = '/workspace/MyBot/docker-compose.yml';

  // 1. Syntax check every .js file
  let jsFiles = [];
  try {
    jsFiles = fs.readdirSync(APP_DIR).filter(f => f.endsWith('.js'));
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Cannot read ${APP_DIR}: ${err.message}` });
  }
  const syntaxErrors = [];
  for (const f of jsFiles) {
    try {
      execSync(`node -c "${path.join(APP_DIR, f)}"`, { stdio: 'pipe' });
    } catch (err) {
      const stderr = (err.stderr || '').toString().split('\n').slice(0, 3).join(' ');
      syntaxErrors.push(`${f}: ${stderr}`);
    }
  }
  if (syntaxErrors.length > 0) {
    return res.status(400).json({
      ok: false,
      error: 'Syntax errors found — refusing to rebuild',
      details: syntaxErrors,
    });
  }

  // 2. Flush all pending channel state writes
  try {
    const { flushPendingWrites } = require('./channel-persistence');
    flushPendingWrites();
  } catch (err) {
    console.error('[rebuild] flushPendingWrites failed:', err.message);
  }

  // 3. (Removed) Rebuild-triggered restart notifications were annoying users in
  //    channels that weren't actively talking to the bot. Auto-resume still
  //    notifies channels that had an activeTask or pendingQueue (crash recovery).

  // Pre-rebuild Signal notifications removed — too noisy for users.

  // L4: validate HOST_PROJECT_PATH before we commit to spawning anything.
  // Even though flipping this env var requires container access, validating
  // here is cheap defense-in-depth — it blocks accidental misconfiguration
  // and any future path where an attacker can influence env.
  const HOST_PROJECT_PATH = process.env.HOST_PROJECT_PATH
    || '/mnt/c/Users/karen/Desktop/Github Projects/MyBot';
  const _pathInvalid =
    typeof HOST_PROJECT_PATH !== 'string' ||
    !HOST_PROJECT_PATH.startsWith('/') ||
    HOST_PROJECT_PATH.split('/').includes('..') ||
    /[;|&$`<>\n\r]/.test(HOST_PROJECT_PATH);
  if (_pathInvalid) {
    console.error('[rebuild] HOST_PROJECT_PATH failed validation:', HOST_PROJECT_PATH);
    return res.status(500).json({
      ok: false,
      error: 'HOST_PROJECT_PATH is invalid or contains unsafe characters',
    });
  }

  // 4. Respond before the rebuild starts so Claude can announce success
  res.json({
    ok: true,
    message: 'Rebuild started — container will be replaced in ~30s',
    syntaxChecked: jsFiles.length,
  });

  // 5. Spawn the rebuild via a SEPARATE host-side container so it survives
  //    THIS container being stopped.
  //
  //    Critical lesson learned the hard way: a process spawned with
  //    `detached: true` from inside a Docker container gets SIGKILLed when
  //    the container is stopped, regardless of unref(). The whole PID
  //    namespace dies. So you MUST hand the rebuild off to something running
  //    on the host.
  //
  //    Approach: ask the host docker daemon to start a new short-lived
  //    `docker:cli` container that:
  //      - mounts the docker socket so it can drive `docker compose`
  //      - mounts the project source from the host at /work
  //      - sleeps a couple seconds to let our HTTP response flush
  //      - runs `docker compose up -d --build` (which stops/replaces THIS
  //        container as part of its normal flow)
  //      - exits and is auto-removed
  //
  //    HOST_PROJECT_PATH is the absolute path on the host to the MyBot
  //    project — required because the docker daemon resolves bind-mount
  //    paths relative to the HOST filesystem, not the calling container.
  //    In dev that's the WSL Windows path; in CI/cloud it'd be different.
  setTimeout(() => {
    try {
      // HOST_HOME passthrough — CRITICAL. The docker:27-cli rebuilder runs
      // as root with HOME=/root by default, and docker-compose substitutes
      // ${HOME} at compose-up time. Without forwarding our HOST_HOME env
      // var, the .claude / .claude.json / .gitconfig bind mounts would
      // resolve to /root/.claude* (which doesn't exist on the host) and
      // Docker would silently create empty mount points there. Result:
      // Claude CLI inside the bot container can't read its credentials and
      // exits at 0 turns. This bit us once on 2026-04-11 — see commit
      // history. The default below mirrors docker-compose.yml.
      const HOST_HOME = process.env.HOST_HOME || '/home/karen';
      console.log(`[rebuild] Spawning host-side rebuild container (HOST_PROJECT_PATH=${HOST_PROJECT_PATH}, HOST_HOME=${HOST_HOME})`);
      const dockerArgs = [
        'run', '-d', '--rm',
        '--name', `mybot-rebuilder-${Date.now()}`,
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '-v', `${HOST_PROJECT_PATH}:/work`,
        '-w', '/work',
        // Forward HOST_HOME so the inner `docker compose up` substitutes
        // ${HOST_HOME} in volume mounts to the operator's actual home,
        // not the rebuilder's /root.
        '-e', `HOST_HOME=${HOST_HOME}`,
        // L1: pin docker:cli to a specific minor version so supply-chain
        // surprises (a poisoned `latest` tag) can't compromise the rebuild.
        // Update this tag intentionally when upgrading the Docker CLI.
        'docker:27-cli',
        'sh', '-c',
        // Sleep so the HTTP response and any tool_use logs can flush before
        // we start tearing down the original container. The compose up
        // command itself replaces the container; without --build it'd reuse
        // the cached image (we want a fresh build).
        //
        // `-p mybot` is CRITICAL: without it, docker-compose derives the
        // project name from the working directory (`/work` → `work`), which
        // would create a second set of `work-claude-api-1` / `work-signal-api-1`
        // containers instead of replacing the existing `mybot-*` ones.
        'sleep 3 && docker compose -p mybot -f docker-compose.yml --profile signal up -d --build',
      ];
      const child = spawn('docker', dockerArgs, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (err) {
      console.error('[rebuild] spawn failed:', err.message);
    }
  }, 500);
});

// Signal webhook receiver — used when signal-api runs in MODE=json-rpc.
// bbernhard's signal-cli-rest-api forwards every JSON-RPC frame from signal-cli
// to this endpoint. The frames come in three shapes:
//   1. JSON-RPC notification: { jsonrpc, method: "receive", params: { envelope, account } }
//   2. JSON-RPC request:      { jsonrpc, method, params } — same as above
//   3. JSON-RPC response:     { jsonrpc, result, id } — these are ack/result frames, NOT messages
//   4. Bare envelope:         { envelope, account } — the legacy /v1/receive shape
// We unwrap (1)/(2) to get the envelope, ignore (3), and handle (4) directly.
function _extractSignalEnvelope(body) {
  if (!body || typeof body !== 'object') return null;
  // Shape (3): JSON-RPC response — these are not incoming messages, ignore
  if ('result' in body && 'id' in body && !('method' in body)) return null;
  // Shape (1)/(2): JSON-RPC request/notification with method=receive
  if ('jsonrpc' in body && 'method' in body) {
    if (body.method !== 'receive') return null;
    const params = body.params;
    if (!params) return null;
    // params is itself the envelope-shaped object
    return params;
  }
  // Shape (4): bare envelope
  return body;
}

// Signal webhook auth: bbernhard's JSON-RPC forwarder cannot inject custom
// HTTP headers, so we accept the shared secret as a ?token= query string.
// Operators MUST configure signal-api with:
//   RECEIVE_WEBHOOK_URL=http://claude-api:3400/signal/webhook?token=${INTERNAL_API_TOKEN}
// Without the token gate, envelope.sourceNumber is trivially forgeable and an
// attacker could impersonate the owner.
let _signalAuthLastWarnAt = 0;
app.post('/signal/webhook', express.json({ limit: '5mb' }), (req, res) => {
  if (!INTERNAL_API_TOKEN) {
    return res.status(503).end();
  }
  const supplied = typeof req.query.token === 'string' ? req.query.token : '';
  if (!safeTokenEqual(supplied, INTERNAL_API_TOKEN)) {
    const now = Date.now();
    if (now - _signalAuthLastWarnAt > 60000) {
      _signalAuthLastWarnAt = now;
      console.warn('[signal-webhook] rejected request with missing/invalid ?token= (logged at most once/min)');
    }
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const bot = require('./bot'); // late require to avoid cycle
    const adapter = bot.signalAdapter; // read live property; mutated post-init
    if (!adapter || typeof adapter._handleIncoming !== 'function') {
      console.warn('[signal-webhook] signalAdapter not initialized — dropping envelope');
      res.status(200).end();
      return;
    }

    const body = req.body;
    const items = Array.isArray(body) ? body : [body];
    let processed = 0, ignored = 0;
    for (const item of items) {
      const envelope = _extractSignalEnvelope(item);
      if (envelope) {
        // _handleIncoming is async (it downloads attachments) — wrap with
        // .catch so a single bad envelope can't crash the process via an
        // unhandled rejection.
        Promise.resolve(adapter._handleIncoming(envelope)).catch(err => {
          console.error('[signal-webhook] handler error:', err.message, err.stack);
        });
        processed++;
      } else {
        ignored++;
      }
    }
    if (processed > 0) {
      console.log(`[signal-webhook] processed ${processed} envelope(s)${ignored ? `, ignored ${ignored} non-message frame(s)` : ''}`);
    }
    res.status(200).end();
  } catch (err) {
    console.error('[signal-webhook] error:', err.message, err.stack);
    res.status(200).end(); // ack anyway so signal-api doesn't retry the same envelope
  }
});

// Spotify OAuth callback for playlist integration
app.get('/auth/spotify/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state parameter.');
  try {
    const spotifyAuth = require('./spotify-auth');
    const { displayName, email } = await spotifyAuth.handleCallback(code, state);
    res.send(`<h2>Spotify Connected!</h2><p>${escapeHtml(displayName)} (${escapeHtml(email || 'no email')}) is now linked. You can close this tab.</p>`);
  } catch (err) {
    console.error('Spotify OAuth callback error:', err.message);
    res.status(500).send(`<h2>Spotify authorization failed</h2><p>${escapeHtml(err.message)}</p>`);
  }
});

// ── Signal user onboarding setup page ────────────────────────────────────────
// Users tap a link generated by !setup, fill in their name/location, and
// connect Google Calendar — all from their phone browser.
app.get('/setup/:userId', (req, res) => {
  const userId = decodeURIComponent(req.params.userId);

  // F2: verify ephemeral access token — without a valid ?t= param, reject.
  const setupToken = typeof req.query.t === 'string' ? req.query.t : '';
  const accessEntry = _setupAccessTokens.get(setupToken);
  if (
    !accessEntry ||
    accessEntry.expiresAt <= Date.now() ||
    !safeTokenEqual(accessEntry.userId, userId)
  ) {
    return res.status(403).send('Invalid or expired setup link — ask the bot for a new one.');
  }
  // Single-use: delete so the same token can't be reused
  _setupAccessTokens.delete(setupToken);

  const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  // Load existing profile to pre-fill the form
  let profile = {};
  try { profile = require('./user-profiles').getProfile(userId) || {}; } catch {}

  // L7: issue a fresh CSRF token tied to this userId. Stored server-side
  // with a 30min TTL; POST will verify and delete it (single-use).
  const csrfToken = crypto.randomBytes(16).toString('hex');
  _setupCsrfTokens.set(userId, {
    token: csrfToken,
    expiresAt: Date.now() + SETUP_CSRF_TTL_MS,
  });
  _capMap(_setupCsrfTokens, 10000, '_setupCsrfTokens');

  const calConnected = profile.gcal_connected
    ? `<p style="color:#4caf50;font-weight:bold;">✓ Google Calendar connected (${escapeHtml(profile.gcal_email)})</p>`
    : '';

  // F3: generate a separate ephemeral token for the Google Calendar OAuth link
  // so clicking "Connect Google Calendar" from the setup page is also gated.
  let gcalToken = '';
  if (googleConfigured) {
    gcalToken = crypto.randomBytes(24).toString('hex');
    _setupAccessTokens.set(gcalToken, {
      userId,
      expiresAt: Date.now() + SETUP_ACCESS_TTL_MS,
    });
    _capMap(_setupAccessTokens, 10000, '_setupAccessTokens');
  }

  const googleBtn = googleConfigured
    ? `<a href="/auth/google/calendar/${encodeURIComponent(userId)}?t=${encodeURIComponent(gcalToken)}" style="display:inline-block;background:#4285f4;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:16px;">Connect Google Calendar</a>`
    : `<p style="color:#999;">Google Calendar not configured on this server.</p>`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bot Setup</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 20px; background: #f5f5f5; }
    h1 { font-size: 24px; margin-bottom: 4px; }
    .sub { color: #666; margin-bottom: 32px; font-size: 14px; }
    label { display: block; font-weight: 600; margin: 16px 0 4px; }
    input, select { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 16px; box-sizing: border-box; }
    button { margin-top: 20px; width: 100%; background: #222; color: #fff; border: none; padding: 14px; border-radius: 6px; font-size: 16px; cursor: pointer; }
    .section { background: #fff; border-radius: 10px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    .success { color: #4caf50; font-weight: bold; }
  </style>
</head>
<body>
  <h1>Set Up Your Profile</h1>
  <p class="sub">Phone: ${escapeHtml(userId)}</p>

  <div class="section">
    <form method="POST" action="/setup/${encodeURIComponent(userId)}?t=${encodeURIComponent(setupToken)}">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="_t" value="${escapeHtml(setupToken)}">
      <label for="name">Your Name</label>
      <input type="text" id="name" name="name" value="${escapeHtml(profile.name || '')}" placeholder="e.g. Mike" required>

      <label for="location">Your City / Location</label>
      <input type="text" id="location" name="location" value="${escapeHtml(profile.location || '')}" placeholder="e.g. Austin, TX" required>

      <label for="timezone">Timezone</label>
      <select id="timezone" name="timezone">
        ${[
          'America/New_York','America/Chicago','America/Denver','America/Los_Angeles',
          'America/Phoenix','America/Anchorage','Pacific/Honolulu',
          'Europe/London','Europe/Paris','Europe/Berlin','Asia/Tokyo','Asia/Seoul','Australia/Sydney'
        ].map(tz => `<option value="${escapeHtml(tz)}"${profile.timezone === tz ? ' selected' : ''}>${escapeHtml(tz.replace('_',' '))}</option>`).join('')}
      </select>

      <button type="submit">Save Profile</button>
    </form>
  </div>

  <div class="section">
    <strong>Google Calendar (read-only)</strong>
    <p style="color:#666;font-size:14px;margin:8px 0 16px;">Connect so the bot can check your calendar when you ask.</p>
    ${calConnected}
    ${googleBtn}
  </div>
</body>
</html>`);
});

app.post('/setup/:userId', express.urlencoded({ extended: false }), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);

  // F2: verify that the POST came from a form rendered by the gated GET.
  // The access token was already consumed by GET (single-use), so we just
  // check that ?t= is present and non-empty — the CSRF token is the real
  // POST protection.
  const setupToken = typeof req.query.t === 'string' ? req.query.t : '';
  if (!setupToken) {
    return res.status(403).send('Invalid or expired setup link — ask the bot for a new one.');
  }

  const { name, location, timezone } = req.body;

  // L7: verify same-origin CSRF token. Each GET issues a fresh token scoped
  // to the userId with a 30min TTL; POST must present the matching token and
  // we delete it on success (single-use) so a replay can't resubmit.
  const submitted = req.body && req.body._csrf;
  const entry = _setupCsrfTokens.get(userId);
  // F13: use safeTokenEqual instead of === for constant-time comparison
  const csrfOk =
    entry &&
    typeof submitted === 'string' &&
    submitted.length > 0 &&
    safeTokenEqual(entry.token, submitted) &&
    entry.expiresAt > Date.now();
  if (!csrfOk) {
    if (entry) _setupCsrfTokens.delete(userId); // scrub stale/expired entries
    return res.status(403).send('Invalid or expired form token — refresh the page and try again.');
  }
  _setupCsrfTokens.delete(userId);

  try {
    require('./user-profiles').setProfile(userId, {
      name: (name || '').trim(),
      location: (location || '').trim(),
      timezone: timezone || 'America/New_York',
      setup_complete: true,
    });
  } catch (err) {
    console.error('[setup] save error:', err.message);
    return res.status(500).send('<p>Save failed. Please try again.</p>');
  }
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Profile Saved</title>
<style>body{font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;text-align:center;}</style></head>
<body>
  <h1>✓ Profile Saved!</h1>
  <p>Name: <strong>${escapeHtml((name||'').trim())}</strong><br>Location: <strong>${escapeHtml((location||'').trim())}</strong><br>Timezone: <strong>${escapeHtml(timezone||'')}</strong></p>
  <p style="margin-top:32px;color:#666;">You can close this tab. Come back to connect Google Calendar if you haven't already.</p>
  <p style="margin-top:16px;color:#999;font-size:14px;">To edit your profile again, ask the bot for a new setup link.</p>
</body></html>`);
});

// Google Calendar OAuth — phone-number-aware (works for Signal users)
// F3: gated behind the same ephemeral token as /setup/:userId (F2). The
// !connect bot command must request a setup token first via /internal/setup-token.
app.get('/auth/google/calendar/:userId', async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);

  // F3: verify ephemeral access token
  const setupToken = typeof req.query.t === 'string' ? req.query.t : '';
  const accessEntry = _setupAccessTokens.get(setupToken);
  if (
    !accessEntry ||
    accessEntry.expiresAt <= Date.now() ||
    !safeTokenEqual(accessEntry.userId, userId)
  ) {
    return res.status(403).send('Invalid or expired setup link — ask the bot for a new one.');
  }
  _setupAccessTokens.delete(setupToken); // single-use

  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(400).send('Google OAuth not configured on this server.');
  }
  try {
    const googleAuth = require('./google-auth');
    const authUrl = googleAuth.getAuthUrl(userId);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`OAuth error: ${escapeHtml(err.message)}`);
  }
});

// Google OAuth callback for multi-user calendar access
app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state parameter.');
  try {
    const googleAuth = require('./google-auth');
    const { email, displayName } = await googleAuth.handleCallback(code, state);
    res.send(`<h2>Connected!</h2><p>${escapeHtml(displayName)} (${escapeHtml(email)}) is now linked to your Discord account. You can close this tab.</p>`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.status(500).send(`<h2>Authorization failed</h2><p>${escapeHtml(err.message)}</p>`);
  }
});

// Reports channels with active Claude processes — used by Claude before self-rebuilding
app.get('/active-sessions', requireInternalToken, (req, res) => {
  try {
    const { channels, client } = require('./bot');
    const active = [];
    for (const [channelId, state] of channels) {
      if (state.busy || state.process) {
        const ch = client.channels.cache.get(channelId);
        active.push({ channelId, name: ch ? ch.name : channelId });
      }
    }
    res.json({ active, count: active.length });
  } catch {
    res.json({ active: [], count: 0 });
  }
});

// ── F2: issue ephemeral setup access tokens ──────────────────────────────────
// Called by the bot (e.g. !setup, !connect) to generate a single-use URL for
// a specific userId. Gated by requireInternalToken so only the bot process can
// request tokens.
app.post('/internal/setup-token', requireInternalToken, (req, res) => {
  const { userId } = req.body;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId required' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  _setupAccessTokens.set(token, {
    userId,
    expiresAt: Date.now() + SETUP_ACCESS_TTL_MS,
  });
  _capMap(_setupAccessTokens, 10000, '_setupAccessTokens');
  res.json({
    token,
    url: '/setup/' + encodeURIComponent(userId) + '?t=' + token,
  });
});

const PORT = 3400;
app.listen(PORT, () => {
  console.log(`Claude API wrapper listening on port ${PORT}`);

  // After 30s of healthy running, snapshot code as last-known-good
  setTimeout(() => {
    try {
      const { snapshotGoodState } = require('./safe-rebuild');
      snapshotGoodState();
    } catch (err) {
      console.error('[safe-rebuild] Snapshot error:', err.message);
    }
  }, 30000);
});

// Start Discord bot
const bot = require('./bot');
bot.start();
