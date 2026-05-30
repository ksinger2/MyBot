const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// H2 (auth hardening): capture INTERNAL_API_TOKEN into a closure and delete
// it from process.env BEFORE any other require() runs. This prevents any
// downstream code (runner spawns, plugin child_process calls, etc.) from
// leaking the token to subprocesses via inherited env. Loaded first so every
// subsequent module sees the scrubbed process.env.
const { getInternalToken } = require('./internal-token');
const { atomicWriteJsonSync } = require('./atomic-write');

// Security: fail-closed if TOKEN_ENCRYPTION_KEY is not set. User profiles,
// OAuth tokens, and Spotify tokens are encrypted at rest with this key.
// Without it, all personal data would be stored in plaintext.
if (!process.env.TOKEN_ENCRYPTION_KEY) {
  console.error('[FATAL] TOKEN_ENCRYPTION_KEY not set in environment. Refusing to start — user data would be unencrypted. Set a random 32+ char value in .env.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
// L5: cap default JSON body size at 1mb. The per-route /signal/webhook override
// (5mb) still applies because it's mounted locally on that route.
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/setup/') || req.path === '/debug') {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  }
  next();
});

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
// Store setup return URLs so OAuth callbacks can redirect back to the setup page.
// Keyed by userId, set before OAuth redirect, consumed on callback.
const _oauthReturnUrls = new Map();
const SETUP_ACCESS_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── M2 + L7: periodic cleanup intervals ──────────────────────────────────────
// Module-level guard so `require.cache` re-entry (hot reload, test harness)
// doesn't register duplicate intervals.
if (!global.__mybotServerIntervals) {
  global.__mybotServerIntervals = true;

  // Sandbox cred refresh: every 60s, sync /home/node/.claude/.credentials.json
  // into each sandbox user's home. Token rotates in /home/node/ asynchronously,
  // and sandbox users keep stale copies otherwise → 401 on next group-chat
  // spawn. Per-spawn refresh exists too, but this loop closes the race window
  // for spawns that started just as a rotation completed.
  setInterval(() => {
    try { require('./sandbox').refreshAllCredentials(); }
    catch (err) { console.warn(`[sandbox-cred-refresh] ${err.message}`); }
  }, 60 * 1000).unref();

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
// The secret is loaded via internal-token.js (closure-backed). It is NOT
// read from process.env here — process.env.INTERNAL_API_TOKEN has already
// been deleted by the internal-token module to prevent child-process leakage.
// If unset, every authenticated route 503s — we never fail open.
const INTERNAL_API_TOKEN = getInternalToken();
if (!INTERNAL_API_TOKEN) {
  console.error('[security] WARNING: INTERNAL_API_TOKEN not set — all authenticated routes will be unreachable');
} else {
  // H2 startup probe: confirm process.env has been scrubbed. If this logs
  // "LEAKED" something re-populated the var after internal-token.js ran.
  const envState = process.env.INTERNAL_API_TOKEN ? 'LEAKED' : 'scrubbed';
  console.log(`[security] INTERNAL_API_TOKEN loaded via closure; process.env state: ${envState}`);
}

// Constant-time string compare (F12 / S4: pad both inputs to equal length so
// timingSafeEqual always runs — prevents timing leak of token length).
function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  Buffer.from(a).copy(bufA);
  Buffer.from(b).copy(bufB);
  return a.length === b.length && crypto.timingSafeEqual(bufA, bufB);
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

function parseBooleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return raw === '1' || raw === 'true';
}

function createRateLimiter({ windowMs, max, keyFn, label }) {
  const buckets = new Map();
  const limiter = (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: `${label || 'rate'} limit exceeded` });
    }
    bucket.count += 1;
    next();
  };
  limiter.clear = (key) => buckets.delete(key);
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, 15 * 60 * 1000).unref();
  return limiter;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getBearerToken(req) {
  const auth = req.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
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
    '--allowedTools', ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'TodoWrite', 'Task'].join(','),
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

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
    res.status(504).json({ error: 'Claude CLI timed out' });
  }, 120000);

  child.on('close', (code) => {
    clearTimeout(timeout);
    if (timedOut || res.headersSent) return;
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

// Deterministic test runner — runs the project's test command and returns structured results.
// Used by the QA gate to verify code before [REBUILD].
app.post('/test', requireInternalToken, async (req, res) => {
  const { cwd } = req.body;
  const testDir = cwd || '/app';

  const child = spawn('node', ['--test', 'tests/*.test.js'], {
    cwd: testDir,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
    if (!res.headersSent) res.status(504).json({ error: 'Test run timed out (120s)' });
  }, 120000);

  child.on('close', (code) => {
    clearTimeout(timeout);
    if (timedOut || res.headersSent) return;

    const passed = code === 0;
    const passMatch = stdout.match(/# pass (\d+)/);
    const failMatch = stdout.match(/# fail (\d+)/);
    res.json({
      passed,
      exitCode: code,
      passCount: passMatch ? parseInt(passMatch[1], 10) : null,
      failCount: failMatch ? parseInt(failMatch[1], 10) : null,
      output: stdout.slice(-2000),
      errors: stderr.slice(-1000),
    });
  });
});

// Internal image generation endpoint — called by Claude CLI via curl
app.post('/imagine', requireInternalToken, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'No OPENAI_API_KEY configured' });

  // Resolve chatId for the image registry. Priority:
  // 1. X-Session-Key header (set via $IMAGE_SESSION_KEY env var in curl)
  // 2. sessionKey in request body (if Claude passes it)
  // 3. Fallback: find the only active session in the registry
  const imageRegistry = require('./image-registry');
  const chatId = req.headers['x-session-key']
    || req.body.sessionKey
    || imageRegistry.findActiveChatId();

  // Resolve input image: explicit request body > registry > none
  const resolvedInputImage = (req.body.inputImagePath && fs.existsSync(req.body.inputImagePath))
    ? req.body.inputImagePath
    : (chatId ? imageRegistry.consumeInput(chatId) : null);

  if (resolvedInputImage) {
    console.log(`[imagine] using input image: ${resolvedInputImage}${req.body.inputImagePath ? ' (from request)' : ' (from registry — Claude omitted it)'}`);
  }

  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let base64;
    if (resolvedInputImage && fs.existsSync(resolvedInputImage)) {
      // Image-to-image: use gpt-image-1.5 which has higher fidelity to input
      // images than gpt-image-1. The edit prompt is augmented to emphasize
      // preserving the subject's visual identity from the reference photo.
      const { toFile } = require('openai');
      const ext = path.extname(resolvedInputImage).toLowerCase();
      const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
        : 'image/png';
      const imgSize = fs.statSync(resolvedInputImage).size;
      console.log(`[imagine] Image-to-image with gpt-image-1.5 (${(imgSize / 1024).toFixed(0)}KB ${mimeType})`);
      const editPrompt = `IMPORTANT: The attached photo is a visual reference. The generated image MUST preserve the exact same subject — same breed, same color, same physical features, same appearance. Do not change the subject's look. ${prompt}`;
      const response = await openai.images.edit({
        model: 'gpt-image-1.5',
        image: await toFile(fs.createReadStream(resolvedInputImage), path.basename(resolvedInputImage), { type: mimeType }),
        prompt: editPrompt,
        n: 1,
        size: '1024x1024',
        quality: 'high',
      });
      base64 = response.data[0].b64_json;
    } else {
      // Text-to-image: no input image, generate from prompt only
      const response = await openai.images.generate({
        model: 'gpt-image-1.5',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'high',
      });
      base64 = response.data[0].b64_json;
    }
    const buffer = Buffer.from(base64, 'base64');
    const imgPath = `/tmp/imagine_${Date.now()}.png`;
    fs.writeFileSync(imgPath, buffer);

    // Register the output image so bot.js can send it as an attachment
    // deterministically — no prompt compliance required
    if (chatId) imageRegistry.addOutput(chatId, imgPath);

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
    atomicWriteJsonSync(PENDING_EVENTS_FILE, Object.fromEntries(_pendingGroupEvents));
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

// Check free/busy availability for multiple users over a time range
app.post('/calendar/freebusy', requireInternalToken, async (req, res) => {
  const { user_ids, start, end } = req.body;
  if (!user_ids || !Array.isArray(user_ids) || !start || !end) {
    return res.status(400).json({ error: 'user_ids (array), start (ISO), and end (ISO) are required' });
  }
  try {
    const { getAvailability } = require('./calendar-coordinator');
    const results = await getAvailability(user_ids, { start, end });
    // Annotate with names from profiles
    const userProfiles = require('./user-profiles');
    const annotated = results.map(r => {
      const profile = userProfiles.getProfile(r.userId);
      return {
        ...r,
        name: profile?.name || r.userId,
        free: !r.error && r.busy.length === 0,
      };
    });
    res.json({ results: annotated });
  } catch (err) {
    console.error('[calendar/freebusy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/event', requireInternalToken, async (req, res) => {
  const { title, datetime, end_datetime, duration_minutes, location, description, user_ids, chat_id, color_id, color_name, reminder_minutes } = req.body;
  if (!title || !datetime || !user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
    return res.status(400).json({ error: 'title, datetime (ISO 8601), and user_ids (array of phone numbers or Discord IDs) are required' });
  }

  const googleAuth = require('./google-auth');
  const userTokens = require('./user-tokens');

  const startTime = new Date(datetime);
  const endDt = end_datetime ? new Date(end_datetime) : null;
  const durationMs = (duration_minutes || 120) * 60 * 1000;
  const endTime = endDt || new Date(startTime.getTime() + durationMs);

  // Do NOT pre-gather a shared attendees list — adding all user emails as
  // attendees on every calendar entry sends unwanted cross-invitations.
  // Each event is created independently on each person's own calendar.

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
          ...(color_id ? { colorId: String(color_id) } : {}),
          ...(reminder_minutes != null ? {
            reminders: {
              useDefault: false,
              overrides: [{ method: 'popup', minutes: parseInt(reminder_minutes, 10) }],
            },
          } : {}),
        },
      });
      const tok = userTokens.getTokenForSignalUser(userId);
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
      color_id: color_id || null,
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
    const tok = userTokens.getTokenForSignalUser(uid);
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
    const tok = userTokens.getTokenForSignalUser(user_id);

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

let _rebuildInProgress = false;
app.get('/health', (req, res) => {
  // Reuse the oncall-watchdog's cached CLI health result instead of spawning
  // a separate `claude --version` on every health check request.
  try {
    const { getCliHealthCache } = require('./oncall-watchdog');
    const cached = getCliHealthCache();
    const STALE_THRESHOLD = 5 * 60 * 1000;
    if (cached.ts > 0 && (Date.now() - cached.ts) < STALE_THRESHOLD) {
      return res.status(cached.ok ? 200 : 503).json({
        status: cached.ok ? 'ok' : 'degraded',
        claude: cached.version || 'unknown',
      });
    }
  } catch {}
  // Fallback: watchdog hasn't run yet — do a direct check
  try {
    const v = require('child_process').execFileSync('claude', ['--version'], { timeout: 5000, encoding: 'utf8' }).trim();
    res.json({ status: 'ok', claude: v });
  } catch (e) {
    res.status(503).json({ status: 'degraded', error: 'Claude CLI not functional', detail: e.message });
  }
});

app.get('/health/watchdog', requireInternalToken, (req, res) => {
  try {
    const { getHealthReport } = require('./oncall-watchdog');
    res.json(getHealthReport());
  } catch (err) {
    res.status(500).json({ error: 'Watchdog not available', detail: err.message });
  }
});

const VOICE_AUTH_TOKEN = process.env.VOICE_AUTH_TOKEN || '';
const VOICE_ENABLED = parseBooleanEnv('VOICE_ENABLED', true);
const OWNER_FULL_ACCESS_ENABLED = parseBooleanEnv('OWNER_FULL_ACCESS', false);
const voiceRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.VOICE_RATE_LIMIT_MAX, 10) || 20,
  keyFn: (req) => `voice:${clientIp(req)}`,
  label: 'voice',
});

function requireVoiceAccess(req, res, next) {
  if (!VOICE_ENABLED) return res.status(404).json({ error: 'not found' });
  if (!VOICE_AUTH_TOKEN) {
    return res.status(503).json({ error: 'voice auth not configured' });
  }
  const supplied = req.get('X-Voice-Token') || getBearerToken(req) || '';
  if (!safeTokenEqual(supplied, VOICE_AUTH_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ── Voice endpoint — for iOS Shortcut / Siri integration ──
// "Hey Siri, [trigger phrase]..." → Shortcut POSTs text here → full bot pipeline → Siri speaks response
// Routes through the same askClaude pipeline as Signal DMs so Bianca has full
// context: Eight Sleep, calendar, profile, personality, conversation history.
app.post('/voice', requireVoiceAccess, voiceRateLimit, async (req, res) => {
  let { text, pin } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  // Voice requests require a transport token and the bot PIN.
  const expectedPin = process.env.BOT_UNLOCK_PIN;
  if (!expectedPin || !safeTokenEqual(String(pin || ''), expectedPin)) {
    return res.status(401).json({ error: 'invalid pin' });
  }

  // Strip Siri trigger phrase — iOS Shortcuts sometimes prepend the shortcut
  // name to the dictated text (e.g. "Summon Bianca what time is it")
  text = text.replace(/^(summon\s+bianca|hey\s+bianca|bianca|hey\s+b)\s*/i, '').trim();
  if (!text) return res.json({ response: "What would you like to know?" });

  console.log(`[voice] Siri request: "${text.substring(0, 100)}"`);

  try {
    const { askClaude, getChannelState, getPersonalityFile, signalAdapter } = require('./bot');
    const { SIGNAL_OWNER } = require('./project-permissions');
    const { buildMinimalProfileContext, buildProfileLookup, getProfile } = require('./user-profiles');

    // Use the owner's Signal DM channel state for identity + personality
    const chatId = `signal:${SIGNAL_OWNER}`;
    const state = getChannelState(chatId);
    const personalityFile = getPersonalityFile(state.personality || 'tiffany_pollard');
    let profileContext = buildMinimalProfileContext(SIGNAL_OWNER) || '';
    const _voiceProfile = getProfile(SIGNAL_OWNER);

    // Heuristic: inject heavy profile data when the message needs it
    const lowerText = text.toLowerCase();
    const extraFields = [];
    if (/\b(concerts?|tickets?|music|artists?|shows?|tours?|touring|live|gigs?|spotify|festival)\b/.test(lowerText)) {
      extraFields.push('artists');
    }
    if (/\b(note|list|saved|restaurant|remember|wrote down|my\s+(?:list|notes?))\b/.test(lowerText)) {
      extraFields.push('notes');
    }
    if (extraFields.length > 0) {
      const lookup = buildProfileLookup(SIGNAL_OWNER, extraFields);
      if (lookup) profileContext += '\n\n' + lookup;
    }

    const voicePrompt = text;

    // Run through the full bot pipeline with voice-optimized settings:
    // - haiku for speed (~3x faster than sonnet, fine for simple queries)
    // - isVoice: true for ultra-compact system prompt (~1K tokens vs ~10K)
    // - maxTurns: 3 (tag output + done, no rabbit holes)
    const claudePromise = askClaude(voicePrompt, {
      sessionId: null, // independent session — don't interfere with active Signal DM
      personalityFile,
      identity: state.identity,
      cwd: state.cwd,
      readOnly: !OWNER_FULL_ACCESS_ENABLED,
      profileContext,
      model: 'haiku',
      maxTurns: 3,
      streamReplies: false,
      isVoice: true,
      isOwner: true,
      ownerDmMode: true,
      userTimezone: _voiceProfile?.timezone || null,
    });

    // Race against Siri's ~30s timeout
    const timeoutPromise = new Promise(resolve => {
      setTimeout(() => resolve({ text: null, _timedOut: true }), 25000);
    });

    const result = await Promise.race([claudePromise, timeoutPromise]);

    if (result.authFailed) {
      console.error('[voice] Auth failed — CLI not logged in');
      const fallback = "Sorry, I'm having trouble connecting right now. Try again in a moment.";
      // Send to Signal so user knows
      if (signalAdapter) {
        signalAdapter.sendMessage(SIGNAL_OWNER, `🎙️ *Via Siri:* ${text}\n\n⚠️ Voice failed — CLI auth error. Run \`claude\` on the host and \`/login\`.`).catch(() => {});
      }
      return res.json({ response: fallback });
    }

    // ── Tag processing: execute action tags and inline results ──
    // Claude outputs tags like [EIGHTSLEEP: status left] that are normally
    // processed by bot.js's post-processing pipeline. For voice, we process
    // them here and replace the tag with the actual result text.
    if (result.text && !result._timedOut) {
      let processed = result.text;

      // [EIGHTSLEEP:] → execute Eight Sleep commands
      const esRe = /\[EIGHTSLEEP:\s*(.+?)\]/gi;
      const esMatches = [...processed.matchAll(esRe)];
      if (esMatches.length > 0) {
        try {
          const eightSleep = require('./eight-sleep');
          const { getProfile } = require('./user-profiles');
          const profile = getProfile(SIGNAL_OWNER);
          for (const m of esMatches) {
            const parts = m[1].trim().split(/\s+/);
            const action = (parts[0] || '').toLowerCase();
            let side = (parts[1] || 'my').toLowerCase();
            if (side === 'my' || side === 'mine') side = profile?.eightsleep_side || 'left';
            let tagResult = '';
            try {
              if (action === 'status') {
                const s = await eightSleep.getStatus(SIGNAL_OWNER, side);
                if (s && !s.error) {
                  const levelStr = s.level != null ? `level ${s.level > 0 ? '+' : ''}${s.level}` : '';
                  tagResult = `Your ${side} side is ${s.on ? 'on' : 'off'}${levelStr ? ', ' + levelStr : ''}`;
                } else tagResult = s?.error || 'Could not read Eight Sleep status';
              } else if (action === 'set') {
                const level = parseInt(parts[2], 10) || 0;
                await eightSleep.setTemp(SIGNAL_OWNER, side, level);
                tagResult = `Set your ${side} side to level ${level}`;
              } else if (action === 'on') {
                await eightSleep.turnOn(SIGNAL_OWNER, side);
                tagResult = `Turned your ${side} side on`;
              } else if (action === 'off') {
                await eightSleep.turnOff(SIGNAL_OWNER, side);
                tagResult = `Turned your ${side} side off`;
              }
            } catch (e) { tagResult = `Eight Sleep error: ${e.message?.substring(0, 100)}`; }
            processed = processed.replace(m[0], tagResult);
          }
        } catch (e) { console.warn(`[voice] eightsleep module error: ${e.message}`); }
      }

      // [CALENDAR:] → fetch calendar events
      const calRe = /\[CALENDAR:\s*(.*?)\]/gi;
      const calMatches = [...processed.matchAll(calRe)];
      if (calMatches.length > 0) {
        try {
          const http = require('http');
          for (const m of calMatches) {
            const raw = (m[1] || '').trim();
            const params = {};
            raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
            params.userId = SIGNAL_OWNER;
            params.isGroupChat = false;
            let tagResult = '';
            try {
              const body = JSON.stringify(params);
              const calResult = await new Promise((resolve, reject) => {
                const req = http.request({
                  hostname: 'localhost', port: 3400, path: '/calendar/events',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_API_TOKEN, 'Content-Length': Buffer.byteLength(body) },
                  timeout: 10000,
                }, (res) => {
                  let data = '';
                  res.on('data', c => data += c);
                  res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ text: data }); } });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.write(body); req.end();
              });
              tagResult = calResult?.text || 'No calendar events found';
            } catch (e) { tagResult = 'Could not check calendar'; }
            processed = processed.replace(m[0], tagResult);
          }
        } catch (e) { console.warn(`[voice] calendar error: ${e.message}`); }
      }

      // [WEATHER:] → fetch forecast
      const wxRe = /\[WEATHER:\s*(.+?)\]/gi;
      const wxMatches = [...processed.matchAll(wxRe)];
      if (wxMatches.length > 0) {
        try {
          const weatherPlugin = require('./plugins/weather');
          for (const m of wxMatches) {
            const raw = m[1].trim();
            const params = {};
            raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
            if (!params.location && !raw.includes('=')) params.location = raw;
            let tagResult = '';
            try {
              tagResult = await weatherPlugin.getForecast(params.location, params.fromDate || null, params.toDate || null) || 'No forecast available';
            } catch (e) { tagResult = 'Could not fetch weather'; }
            processed = processed.replace(m[0], tagResult);
          }
        } catch (e) { console.warn(`[voice] weather error: ${e.message}`); }
      }

      // [PRODUCT:] → search products
      const prodRe = /\[PRODUCT:\s*(.+?)\]/gi;
      const prodMatches = [...processed.matchAll(prodRe)];
      if (prodMatches.length > 0) {
        try {
          const productPlugin = require('./plugins/product-search');
          for (const m of prodMatches) {
            const raw = m[1].trim();
            const params = {};
            raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
            if (!params.query && !raw.includes('=')) params.query = raw;
            let tagResult = '';
            try {
              tagResult = await productPlugin.searchProducts(params.query, { wantPrices: params.wantPrices === 'true' }) || 'No results found';
            } catch (e) { tagResult = 'Could not search products'; }
            processed = processed.replace(m[0], tagResult);
          }
        } catch (e) { console.warn(`[voice] product error: ${e.message}`); }
      }

      // [REMIND:] → create reminder
      const remRe = /\[REMIND:\s*(.+?)\]/gi;
      const remMatches = [...processed.matchAll(remRe)];
      if (remMatches.length > 0) {
        try {
          const http = require('http');
          for (const m of remMatches) {
            const raw = (m[1] || '').trim();
            const params = {};
            raw.replace(/(\w+)="([^"]+)"/g, (_, k, v) => { params[k] = v; });
            raw.replace(/(\w+)=(\d+)/g, (_, k, v) => { params[k] = v; });
            params.user_id = SIGNAL_OWNER;
            params.discord_user_id = SIGNAL_OWNER;
            let tagResult = '';
            if (params.title && params.datetime) {
              try {
                const body = JSON.stringify({
                  title: params.title, datetime: params.datetime,
                  duration_minutes: parseInt(params.duration_minutes, 10) || 15,
                  user_id: SIGNAL_OWNER, discord_user_id: SIGNAL_OWNER,
                });
                await new Promise((resolve, reject) => {
                  const req = http.request({
                    hostname: 'localhost', port: 3400, path: '/remind',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_API_TOKEN, 'Content-Length': Buffer.byteLength(body) },
                    timeout: 10000,
                  }, (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => resolve(data));
                  });
                  req.on('error', reject);
                  req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                  req.write(body); req.end();
                });
                tagResult = `Reminder set: ${params.title}`;
              } catch (e) { tagResult = 'Could not create reminder'; }
            }
            processed = processed.replace(m[0], tagResult);
          }
        } catch (e) { console.warn(`[voice] remind error: ${e.message}`); }
      }

      // [LEARNED:] → save preference, strip from response
      const learnRe = /\[LEARNED:\s*(.+?)\]/gi;
      const learnMatches = [...processed.matchAll(learnRe)];
      if (learnMatches.length > 0) {
        try {
          const { addPreference } = require('./user-profiles');
          for (const m of learnMatches) {
            const fact = m[1].trim();
            if (fact && fact.length <= 200) {
              try { addPreference(SIGNAL_OWNER, fact, 'conversation'); } catch {}
            }
          }
        } catch {}
        processed = processed.replace(learnRe, '');
      }

      result.text = processed.trim();
      console.log(`[voice] After tag processing: ${result.text?.substring(0, 100)}`);
    }

    // Strip markdown/tags for clean spoken output
    const cleanForSpeech = (raw) => {
      if (!raw) return "I'm not sure what to say to that.";
      return raw
        .replace(/\[(?:LEARNED|IMAGINE|WEATHER|CALENDAR|PRODUCT|CONCERT_PRICES|FLIGHT_SEARCH|REMIND|EVENT|EIGHTSLEEP|REBUILD|NOTE|RESOLVE_NOTE|UPDATE_NOTES|FLIGHT|EVENT_JOIN)[:\s][^\]]*\]/gi, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]+`/g, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/^#+\s+/gm, '')
        .replace(/^[-*]\s+/gm, '')
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[(.+?)\]\(.*?\)/g, '$1')
        .replace(/\/[\w/.-]+\.\w{2,4}/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || "I'm not sure what to say to that.";
    };

    if (result._timedOut) {
      // Claude is still working — let it finish and deliver via Signal
      claudePromise.then(async (fullResult) => {
        if (fullResult.text && signalAdapter) {
          await signalAdapter.sendMessage(SIGNAL_OWNER,
            `🎙️ *Siri asked:* ${text}\n\n${fullResult.text}`
          ).catch(() => {});
          console.log(`[voice] Timed-out result delivered via Signal`);
        }
      }).catch(err => console.error(`[voice] Background completion failed: ${err.message}`));
      res.json({ response: "Let me think about that. I'll send the full answer to Signal." });
    } else {
      const response = cleanForSpeech(result.text);
      console.log(`[voice] Responding (${response.length} chars)`);
      // Mirror to Signal DM so conversation history is maintained
      if (signalAdapter) {
        signalAdapter.sendMessage(SIGNAL_OWNER,
          `🎙️ *Via Siri:* ${text}\n\n${result.text || response}`
        ).catch(() => {});
      }
      res.json({ response });
    }
  } catch (err) {
    console.error(`[voice] Error: ${err.message}`);
    res.json({ response: "Sorry, I couldn't process that right now." });
  }
});

// ── Debug image upload — drag & drop screenshots for sharing with Claude Code ─
const DEBUG_UPLOAD_ENABLED = parseBooleanEnv('DEBUG_UPLOAD_ENABLED', false);
const DEBUG_UPLOAD_DIR = '/tmp/debug-uploads';
const DEBUG_UPLOAD_MAX_BYTES = parseInt(process.env.DEBUG_UPLOAD_MAX_BYTES, 10) || (5 * 1024 * 1024);
const DEBUG_UPLOAD_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const _debugAccessTokens = new Map();
const DEBUG_ACCESS_TTL_MS = 10 * 60 * 1000;
fs.mkdirSync(DEBUG_UPLOAD_DIR, { recursive: true });

function requireDebugAccess(req, res, next) {
  if (!DEBUG_UPLOAD_ENABLED) return res.status(404).send('not found');
  const suppliedInternal = req.get('X-Internal-Token') || '';
  if (safeTokenEqual(suppliedInternal, INTERNAL_API_TOKEN)) return next();
  const debugToken = req.get('X-Debug-Token') || (typeof req.query.t === 'string' ? req.query.t : '');
  const entry = _debugAccessTokens.get(debugToken);
  if (entry && entry.expiresAt > Date.now()) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function resolveDebugUpload(name) {
  const safeName = path.basename(String(name || ''));
  if (!safeName) return null;
  const filePath = path.resolve(DEBUG_UPLOAD_DIR, safeName);
  const baseDir = path.resolve(DEBUG_UPLOAD_DIR) + path.sep;
  if (!filePath.startsWith(baseDir)) return null;
  if (!DEBUG_UPLOAD_EXTS.has(path.extname(safeName).toLowerCase())) return null;
  return filePath;
}

app.get('/debug', requireInternalToken, (req, res) => {
  const debugToken = crypto.randomBytes(24).toString('hex');
  _debugAccessTokens.set(debugToken, { expiresAt: Date.now() + DEBUG_ACCESS_TTL_MS });
  _capMap(_debugAccessTokens, 500, '_debugAccessTokens');
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Debug Upload</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px}
h1{font-size:1.4rem;margin-bottom:8px;color:#fff}
.sub{color:#888;font-size:.85rem;margin-bottom:24px}
#drop{width:100%;max-width:600px;border:2px dashed #444;border-radius:12px;padding:48px 24px;text-align:center;cursor:pointer;transition:all .2s}
#drop.over{border-color:#a78bfa;background:rgba(167,139,250,.08)}
#drop p{color:#999;font-size:.95rem}
#files{width:100%;max-width:600px;margin-top:20px;display:flex;flex-direction:column;gap:10px}
.file-entry{background:#1a1a1a;border-radius:8px;padding:12px;display:flex;align-items:center;gap:12px}
.file-entry img{width:60px;height:60px;object-fit:cover;border-radius:6px;background:#222}
.file-entry .info{flex:1}
.file-entry .path{font-family:monospace;font-size:.8rem;color:#a78bfa;word-break:break-all}
.file-entry .time{font-size:.75rem;color:#666}
input[type=file]{display:none}
</style></head><body>
<h1>Debug Upload</h1>
<p class="sub">Drag & drop images here. Files save to /tmp/debug-uploads/ for Claude Code to read.</p>
<div id="drop" onclick="document.getElementById('picker').click()">
<p>Drop images here or click to browse</p>
</div>
<input type="file" id="picker" accept="image/*" multiple>
<div id="files"></div>
<script>
const DEBUG_TOKEN=${JSON.stringify(debugToken)};
const drop=document.getElementById('drop'),picker=document.getElementById('picker'),filesDiv=document.getElementById('files');
['dragenter','dragover'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('over')}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('over')}));
drop.addEventListener('drop',e=>{if(e.dataTransfer.files.length)upload(e.dataTransfer.files)});
picker.addEventListener('change',e=>{if(e.target.files.length)upload(e.target.files)});
async function upload(files){
  for(const f of files){
    const form=new FormData();form.append('file',f);
    const r=await fetch('/debug/upload',{method:'POST',headers:{'X-Debug-Token':DEBUG_TOKEN},body:form});
    const j=await r.json();
    if(j.filename){
      const d=document.createElement('div');d.className='file-entry';
      d.innerHTML='<img src="/debug/file/'+encodeURIComponent(j.filename)+'?t='+encodeURIComponent(DEBUG_TOKEN)+'"><div class="info"><div class="path">'+j.filename+'</div><div class="time">'+new Date().toLocaleTimeString()+'</div></div>';
      filesDiv.prepend(d);
    }
  }
}
// Load existing files on page load
fetch('/debug/files',{headers:{'X-Debug-Token':DEBUG_TOKEN}}).then(r=>r.json()).then(files=>{
  files.forEach(f=>{
    const d=document.createElement('div');d.className='file-entry';
    d.innerHTML='<img src="/debug/file/'+encodeURIComponent(f.name)+'?t='+encodeURIComponent(DEBUG_TOKEN)+'"><div class="info"><div class="path">'+f.name+'</div><div class="time">'+new Date(f.mtime).toLocaleTimeString()+'</div></div>';
    filesDiv.appendChild(d);
  });
});
</script></body></html>`);
});

app.post('/debug/upload', requireDebugAccess, (req, res) => {
  // Parse multipart form data manually (no multer dependency)
  const chunks = [];
  let received = 0;
  let rejected = false;
  req.on('data', c => {
    if (rejected) return;
    received += c.length;
    if (received > DEBUG_UPLOAD_MAX_BYTES) {
      rejected = true;
      res.status(413).json({ error: 'file too large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (rejected) return;
    const buf = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return res.status(400).json({ error: 'no boundary' });
    const boundary = boundaryMatch[1];
    const parts = buf.toString('binary').split('--' + boundary);
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd < 0) continue;
      const headers = part.substring(0, headerEnd);
      const fnMatch = headers.match(/filename="([^"]+)"/);
      if (!fnMatch) continue;
      const originalName = fnMatch[1].replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = path.extname(originalName).toLowerCase();
      if (!DEBUG_UPLOAD_EXTS.has(ext)) {
        return res.status(400).json({ error: 'unsupported file type' });
      }
      const typeMatch = headers.match(/Content-Type:\s*([^\r\n;]+)/i);
      if (!typeMatch || !/^image\//i.test(typeMatch[1])) {
        return res.status(400).json({ error: 'image content-type required' });
      }
      const filename = `${Date.now()}_${originalName}`;
      const body = part.substring(headerEnd + 4, part.length - 2); // strip trailing \r\n
      if (Buffer.byteLength(body, 'binary') > DEBUG_UPLOAD_MAX_BYTES) {
        return res.status(413).json({ error: 'file too large' });
      }
      const filePath = resolveDebugUpload(filename);
      if (!filePath) return res.status(400).json({ error: 'invalid filename' });
      fs.writeFileSync(filePath, body, 'binary');
      console.log(`[debug] Uploaded: ${filePath} (${Buffer.byteLength(body, 'binary')} bytes)`);
      return res.json({ filename });
    }
    res.status(400).json({ error: 'no file found in upload' });
  });
});

app.get('/debug/files', requireDebugAccess, (req, res) => {
  try {
    const files = fs.readdirSync(DEBUG_UPLOAD_DIR)
      .filter(f => DEBUG_UPLOAD_EXTS.has(path.extname(f).toLowerCase()))
      .map(f => {
        const stat = fs.statSync(path.join(DEBUG_UPLOAD_DIR, f));
        return { name: f, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 20);
    res.json(files);
  } catch { res.json([]); }
});

app.get('/debug/file/:filename', requireDebugAccess, (req, res) => {
  const filePath = resolveDebugUpload(req.params.filename);
  if (!filePath) return res.status(404).send('not found');
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');
  res.sendFile(filePath);
});

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
  const APP_DIR = '/workspace/MyBot/claude-api';
  const COMPOSE_FILE = '/workspace/MyBot/docker-compose.yml';

  // 0. DETERMINISM: NextSteps.md must have real content before rebuild.
  // Without this gate, Claude can emit [REBUILD] without saving session
  // context, and the rebuild wipes NextSteps.md → context lost forever.
  // The caller can pass skipNextStepsCheck=true for force-rebuild scenarios.
  if (req.body?.skipNextStepsCheck) {
    console.warn('[rebuild] NextSteps.md check SKIPPED via skipNextStepsCheck flag');
  }
  if (!req.body?.skipNextStepsCheck) {
    const nsPath = path.join('/workspace/MyBot', 'NextSteps.md');
    try {
      const nsContent = fs.readFileSync(nsPath, 'utf-8');
      // Strip HTML comments, markdown headers, and whitespace — if nothing
      // substantive remains, NextSteps.md was never updated this session.
      const stripped = nsContent
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^#+\s.*$/gm, '')
        .replace(/\s+/g, '')
        .trim();
      if (!stripped) {
        console.warn('[rebuild] BLOCKED — NextSteps.md has no substantive content');
        return res.status(400).json({
          ok: false,
          error: 'NextSteps.md must be updated before rebuild — update it with current session progress first',
        });
      }
    } catch (e) {
      // If the file doesn't exist at all, that also counts as "not updated"
      console.warn(`[rebuild] BLOCKED — NextSteps.md unreadable: ${e.message}`);
      return res.status(400).json({
        ok: false,
        error: 'NextSteps.md must exist and be updated before rebuild',
      });
    }
  }

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
      require('child_process').execFileSync('node', ['-c', path.join(APP_DIR, f)], { stdio: 'pipe' });
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

  // 1b. Record the repair attempt in the ledger (if reason provided)
  if (req.body.reason) {
    try {
      const repairLedger = require('./repair-ledger');
      repairLedger.addAttempt({
        issue: req.body.reason,
        approach: req.body.approach || 'rebuild triggered',
        filesChanged: req.body.filesChanged || [],
        commitHash: req.body.commitHash || null,
      });
    } catch (e) {
      console.warn(`[rebuild] repair ledger write failed: ${e.message}`);
    }
  }

  // 2. Flush all pending channel state writes
  try {
    const { flushPendingWrites } = require('./channel-persistence');
    flushPendingWrites();
  } catch (err) {
    console.error('[rebuild] flushPendingWrites failed:', err.message);
  }

  // 3. Mark as clean shutdown so the crash notification doesn't fire on restart.
  // Without this, every rebuild triggers "Bot restarted unexpectedly" to the owner.
  // Also write a separate rebuild marker so the bot can DM the owner on startup.
  try {
    fs.writeFileSync(path.join('/home/node/.claude', '.clean-shutdown'), Date.now().toString());
    fs.writeFileSync(path.join('/home/node/.claude', '.rebuild-marker'), Date.now().toString());
    // Snapshot pending work so the rebuild DM can report "up next".
    // Pull from: (1) explicit background tasks, (2) active channel tasks, (3) queued messages
    try {
      const pendingItems = [];
      // Registered background tasks
      const bgTasks = [...(_backgroundTasks || new Map()).values()];
      bgTasks.forEach(t => t.description && pendingItems.push(t.description));
      // Active channel tasks + queued messages — check both in-memory and persisted disk state
      const seenPrompts = new Set();
      const captureChannelState = (state) => {
        if (state.activeTask?.prompt) {
          const p = state.activeTask.prompt.substring(0, 120);
          if (!seenPrompts.has(p)) { seenPrompts.add(p); pendingItems.push('In progress: ' + p); }
        }
        if (state.queue && state.queue.length > 0) {
          state.queue.forEach(q => {
            if (q.content) {
              const p = q.content.substring(0, 120);
              if (!seenPrompts.has(p)) { seenPrompts.add(p); pendingItems.push('Queued: ' + p); }
            }
          });
        }
      };
      // In-memory channels (fastest, most up-to-date)
      try {
        const { channels } = require('./bot');
        if (channels) for (const [, state] of channels) captureChannelState(state);
      } catch {}
      // Persisted disk state (catches tasks that were active before last restart)
      try {
        const stateFile = path.join('/home/node/.claude', 'channel-state.json');
        if (fs.existsSync(stateFile)) {
          const diskStates = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          for (const state of Object.values(diskStates)) captureChannelState(state);
        }
      } catch {}
      // Drop "In progress:" items — the active task IS the one that triggered
      // the rebuild, so it's complete. Only queued items should survive.
      // Without this filter, the raw user prompt (e.g. "yes rebuild") gets
      // re-dispatched as a synthetic message on startup → infinite rebuild loop.
      const safeItems = pendingItems.filter(l => !l.startsWith('In progress: '));
      if (safeItems.length > 0) {
        fs.writeFileSync(path.join('/home/node/.claude', '.pending-work'), safeItems.join('\n'));
      }
    } catch {}
  } catch {}

  // 3b. DETERMINISTIC LOOP PREVENTION — wipe all sources of stale instructions
  // before the container dies. Without this, the new session reads old context
  // ("yes rebuild", "do X") and re-executes it, causing infinite rebuild loops.
  try {
    // (a) Snapshot NextSteps.md before resetting — the gate in step 0 already
    // verified it has content, so this preserves the session context for the
    // rebuild-complete DM and future debugging.
    const nextStepsPath = path.join('/workspace/MyBot', 'NextSteps.md');
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(nextStepsPath, 'utf-8');
      if (currentContent.trim()) {
        fs.writeFileSync(path.join('/home/node/.claude', '.last-nextsteps'), currentContent);
        console.log('[rebuild] Snapshotted NextSteps.md → .last-nextsteps');
      }
    } catch (e) {
      console.warn(`[rebuild] NextSteps.md snapshot failed: ${e.message}`);
    }

    // (a2) Write NextSteps.md with rebuild context in future tense — tells
    // the NEXT bot session what just happened so it has continuity. Uses
    // the snapshot content to summarize what was in progress. No rebuild
    // instructions — just context.
    let prevSummary = '';
    try {
      const snapshot = currentContent
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^#+\s.*$/gm, '')
        .replace(/\[REBUILD\]/gi, '')
        .replace(/\brebuild\b/gi, 'update')
        .trim();
      if (snapshot) prevSummary = snapshot;
    } catch {}
    const rebuildHandoff = `# MyBot — Next Steps

## What's Working
<!-- Updated each session -->
- The bot has just been rebuilt and restarted with new code changes
- All previous sessions have been cleared — you are starting fresh

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
${prevSummary ? `- Before the rebuild, the previous session was working on:\n${prevSummary.split('\n').map(l => l.trim()).filter(l => l).slice(0, 10).map(l => '  - ' + l).join('\n')}` : '- Nothing carried over from previous session'}

## Next Steps
<!-- Prioritized — what to pick up next -->
- Check if the rebuild was successful (smoke test if applicable)
- Resume any queued tasks from the user
`;
    fs.writeFileSync(nextStepsPath, rebuildHandoff);
    console.log('[rebuild] Reset NextSteps.md to clean template');
  } catch (e) {
    console.warn(`[rebuild] NextSteps.md reset failed: ${e.message}`);
  }

  try {
    // (b) Clear session journal — it records promptSummary (the user's raw message)
    // which gets injected as "[Session history — Last session — Asked: yes rebuild]".
    // The new session interprets that as an instruction and loops.
    const journalFile = path.join('/home/node/.claude', 'session-journal.json');
    if (fs.existsSync(journalFile)) {
      atomicWriteJsonSync(journalFile, {});
      console.log('[rebuild] Cleared session journal');
    }
  } catch (e) {
    console.warn(`[rebuild] Session journal clear failed: ${e.message}`);
  }

  // L4: validate HOST_PROJECT_PATH before we commit to spawning anything.
  // Even though flipping this env var requires container access, validating
  // here is cheap defense-in-depth — it blocks accidental misconfiguration
  // and any future path where an attacker can influence env.
  const HOST_PROJECT_PATH = process.env.HOST_PROJECT_PATH;
  if (!HOST_PROJECT_PATH) {
    console.error('[rebuild] HOST_PROJECT_PATH env var is required');
    return res.status(500).json({ ok: false, error: 'HOST_PROJECT_PATH not configured' });
  }
  const _pathInvalid =
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

  // 4. Dedup guard — reject if a rebuild is already running
  if (_rebuildInProgress) {
    return res.status(429).json({ ok: false, error: 'Rebuild already in progress' });
  }
  _rebuildInProgress = true;
  setTimeout(() => { _rebuildInProgress = false; }, 120000);

  // 5. Respond before the rebuild starts so Claude can announce success
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
        'sleep 3 && docker compose -p mybot -f docker-compose.yml --profile signal up -d --build && docker image prune -f && docker builder prune -f --filter until=48h',
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

// Signal webhook auth: prefer Authorization header or X-Internal-Token header,
// but fall back to ?token= query string for bbernhard's signal-cli-rest-api
// sidecar which cannot inject custom HTTP headers.
// Operators SHOULD migrate to header-based auth when possible.
//   RECEIVE_WEBHOOK_URL=http://claude-api:3400/signal/webhook?token=${INTERNAL_API_TOKEN}
// Without the token gate, envelope.sourceNumber is trivially forgeable and an
// attacker could impersonate the owner.
let _signalAuthLastWarnAt = 0;
let _signalQsDeprecationLogged = false;
app.post('/signal/webhook', express.json({ limit: '5mb' }), (req, res) => {
  if (!INTERNAL_API_TOKEN) {
    return res.status(503).end();
  }
  // S3: check headers first (preferred), then fall back to query string
  let supplied = '';
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    supplied = authHeader.slice(7);
  } else if (typeof req.headers['x-internal-token'] === 'string') {
    supplied = req.headers['x-internal-token'];
  } else {
    supplied = typeof req.query.token === 'string' ? req.query.token : '';
    if (supplied && !_signalQsDeprecationLogged) {
      _signalQsDeprecationLogged = true;
      console.warn('[signal-webhook] DEPRECATION: token supplied via query string; prefer Authorization: Bearer or X-Internal-Token header');
    }
  }
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
      try { require('./signal-watchdog').recordWebhookActivity(); } catch {}
      // Track dataMessages separately for WebSocket death detection —
      // receipts still flow even when the text WebSocket is broken.
      const hasDataMessage = items.some(item => {
        const env = _extractSignalEnvelope(item);
        return env && (env.dataMessage || env.syncMessage?.sentMessage);
      });
      if (hasDataMessage) {
        try { require('./signal-watchdog').recordDataMessage(); } catch {}
      }
    }
    res.status(200).end();
  } catch (err) {
    console.error('[signal-webhook] error:', err.message, err.stack);
    res.status(200).end(); // ack anyway so signal-api doesn't retry the same envelope
  }
});

// Spotify OAuth callback — MUST be before /auth/spotify/:userId so Express
// doesn't match "callback" as a userId parameter.
app.get('/auth/spotify/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state parameter.');
  try {
    const spotifyAuth = require('./spotify-auth');
    // Synchronous phase: consume state, exchange code, save tokens, mark
    // profile connected. This is fast (~1-2s).
    const result = await spotifyAuth.handleCallback(code, state);
    const returnUrl = _oauthReturnUrls.get(result.userId);
    if (returnUrl) _oauthReturnUrls.delete(result.userId);
    const redirectScript = returnUrl
      ? `<script>setTimeout(()=>window.location.href=${JSON.stringify(returnUrl)},1500)</script>`
      : '';
    // Respond to the browser IMMEDIATELY so the user doesn't time out and
    // accidentally reload the callback with an already-consumed state.
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spotify Connected</title><style>body{font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;text-align:center;}</style></head><body><h1 style="color:#1DB954;">Spotify Connected!</h1><p>${escapeHtml(result.displayName)} is now linked.</p><p style="color:#666;font-size:14px;">Importing your artists in the background — this takes 30–120 seconds for large libraries. Feel free to close this tab.${returnUrl ? ' Returning to setup...' : ''}</p>${redirectScript}</body></html>`);

    // Async phase (fire-and-forget): import artists in the background.
    // For users with 500+ followed/liked tracks, this can take minutes of
    // sequential Spotify API calls. We intentionally don't await it — the
    // response has already been sent, and any errors are captured in the
    // result.errors array that importUserArtists returns.
    setImmediate(async () => {
      try {
        const importResult = await spotifyAuth.importUserArtists(result.userId, result.accessToken);
        console.log(`[spotify] Background import for ${result.userId.slice(0, 6)}…: imported=${importResult.imported} upgraded=${importResult.upgraded || 0} unique=${importResult.unique} errors=${importResult.errors.length ? importResult.errors.join('|').slice(0, 300) : 'none'}`);
      } catch (err) {
        console.error(`[spotify] Background import failed for ${result.userId.slice(0, 6)}…:`, err.message);
      }
    });
  } catch (err) {
    console.error('Spotify OAuth callback error:', err.message);
    if (!res.headersSent) {
      res.status(500).send(`<h2>Spotify authorization failed</h2><p>${escapeHtml(err.message)}</p>`);
    }
  }
});

// Spotify artist refresh — re-import artists from Spotify without full re-auth
app.post('/spotify/refresh-artists', async (req, res) => {
  // H2: use closure-backed INTERNAL_API_TOKEN (process.env copy is deleted).
  if (!INTERNAL_API_TOKEN || !safeTokenEqual(req.headers['x-internal-token'] || '', INTERNAL_API_TOKEN)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId' });
  try {
    const spotifyAuth = require('./spotify-auth');
    const result = await spotifyAuth.refreshArtists(userId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[spotify/refresh-artists] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Spotify OAuth — gated initiation (same ephemeral token pattern as Google Calendar)
app.get('/auth/spotify/:userId', async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const setupToken = typeof req.query.t === 'string' ? req.query.t : '';
  const accessEntry = _setupAccessTokens.get(setupToken);
  if (!accessEntry || accessEntry.expiresAt <= Date.now() || !safeTokenEqual(accessEntry.userId, userId)) {
    return res.status(403).send('Invalid or expired setup link — ask the bot for a new one.');
  }
  // Don't delete token — user needs it to return to setup page after OAuth
  if (!process.env.SPOTIFY_CLIENT_ID) {
    return res.status(400).send('Spotify OAuth not configured on this server.');
  }
  try {
    // Save return URL so callback can redirect back to setup
    _oauthReturnUrls.set(userId, `/setup/${encodeURIComponent(userId)}?t=${encodeURIComponent(setupToken)}`);
    const spotifyAuth = require('./spotify-auth');
    const authUrl = spotifyAuth.getAuthUrl(userId);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`OAuth error: ${escapeHtml(err.message)}`);
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
  // Keep the token alive for the full TTL so the user can return to the setup
  // page after OAuth redirects (Google Calendar, Spotify) without needing a
  // new link. The token still expires after 30 minutes and is scoped to userId.

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

  // Spotify OAuth token (same ephemeral pattern as Google Calendar)
  const spotifyConfigured = !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
  let spotifyToken = '';
  if (spotifyConfigured) {
    spotifyToken = crypto.randomBytes(24).toString('hex');
    _setupAccessTokens.set(spotifyToken, {
      userId,
      expiresAt: Date.now() + SETUP_ACCESS_TTL_MS,
    });
    _capMap(_setupAccessTokens, 10000, '_setupAccessTokens');
  }

  // Build rules list HTML
  const rules = profile.rules || [];
  const rulesHtml = rules.length > 0
    ? rules.map((r, i) => `<div class="pref" id="rule-${i}"><span>${escapeHtml(r.rule)}</span><span class="pref-meta">${r.addedAt ? new Date(r.addedAt).toLocaleDateString() : ''}</span><button type="button" class="remove-btn" onclick="removeRule(${i},'${escapeHtml(r.rule.replace(/'/g, "\\'"))}')">×</button></div>`).join('')
    : '<p class="empty-msg">No rules set. Use <code>!rules add ...</code> or add one below.</p>';

  // Build preferences list HTML
  const prefs = profile.preferences || [];
  const prefsHtml = prefs.length > 0
    ? prefs.map((p, i) => `<div class="pref" id="pref-${i}"><span>${escapeHtml(p.fact)}</span><span class="pref-meta">${escapeHtml(p.source || '')}${p.learnedAt ? ' \u00b7 ' + new Date(p.learnedAt).toLocaleDateString() : ''}</span><button type="button" class="remove-btn" onclick="removePref(${i},'${escapeHtml(p.fact.replace(/'/g, "\\'"))}')">×</button></div>`).join('')
    : '<p class="empty-msg">No preferences yet — I learn these from our chats.</p>';

  // Build tags HTML
  const tags = profile.tags || [];
  const tagsHtml = tags.map((t, i) => `<span class="tag-pill" id="tag-${i}"><span class="tag-cat">${escapeHtml(t.category)}</span>${escapeHtml(t.label)}<button type="button" onclick="removeTag(${i},'${escapeHtml(t.label.replace(/'/g, "\\'"))}')">\u00d7</button></span>`).join('');

  // Build jobs HTML
  const { getUserSchedules } = require('./schedules-storage');
  const userJobs = getUserSchedules(userId).filter(s => s.type === 'dm-task');
  const jobsHtml = userJobs.map(j => `<div class="job-card" id="job-${j.id}">
    <div class="job-header"><span class="job-name">${escapeHtml(j.description)}</span>
    <label class="toggle"><input type="checkbox" ${j.active ? 'checked' : ''} onchange="toggleJob(${j.id})"><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div>
    <p class="job-prompt">${escapeHtml((j.message || '').substring(0, 300))}${j.message && j.message.length > 300 ? '...' : ''}</p>
    <p class="job-schedule">${escapeHtml(j.description)} \u00b7 <code>${escapeHtml(j.cronRule)}</code></p>
    <div class="job-actions"><button onclick="editJob(${j.id})">Edit</button><button class="btn-danger" onclick="deleteJob(${j.id})">Delete</button></div>
  </div>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Profile Setup</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;color:#1a1a2e;min-height:100vh;}
    .header{background:linear-gradient(135deg,#1a1a2e 0%,#2d2b55 100%);color:#fff;padding:32px 20px 28px;text-align:center;}
    .header h1{font-size:26px;font-weight:700;margin-bottom:4px;}
    .header p{opacity:.7;font-size:14px;}
    .container{max-width:480px;margin:0 auto;padding:16px 16px 40px;}
    .card{background:#fff;border-radius:14px;padding:22px;margin-bottom:16px;border:1px solid rgba(0,0,0,.06);box-shadow:0 2px 8px rgba(0,0,0,.04);}
    .card-title{font-size:16px;font-weight:700;margin-bottom:4px;color:#1a1a2e;}
    .card-desc{font-size:13px;color:#666;margin-bottom:16px;line-height:1.4;}
    label{display:block;font-size:13px;font-weight:600;color:#444;margin:14px 0 5px;letter-spacing:.3px;text-transform:uppercase;}
    input[type="text"],select,textarea{width:100%;padding:12px 14px;border:1.5px solid #ddd;border-radius:10px;font-size:15px;background:#fafafa;transition:border-color .2s,box-shadow .2s;font-family:inherit;-webkit-appearance:none;}
    input:focus,select:focus,textarea:focus{outline:none;border-color:#6c63ff;box-shadow:0 0 0 3px rgba(108,99,255,.12);background:#fff;}
    textarea{resize:vertical;min-height:72px;}
    .btn{display:inline-flex;align-items:center;justify-content:center;width:100%;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;transition:all .15s;-webkit-tap-highlight-color:transparent;}
    .btn:active{transform:scale(.98);}
    .btn-primary{background:linear-gradient(135deg,#6c63ff,#5a52d5);color:#fff;}
    .btn-primary:hover{box-shadow:0 4px 12px rgba(108,99,255,.3);}
    .btn-secondary{background:#f0f2f5;color:#444;border:1.5px solid #ddd;}
    .btn-add{background:#f0eeff;color:#6c63ff;border:1.5px dashed #c4bfff;margin-top:12px;}
    .btn-add:hover{background:#e8e4ff;}
    .btn-danger{background:none;color:#e53935;border:1px solid #ffcdd2;font-size:13px;padding:6px 14px;border-radius:8px;width:auto;}
    .pref{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid #f0f2f5;}
    .pref:last-child{border-bottom:none;}
    .pref span:first-child{flex:1;font-size:14px;line-height:1.4;}
    .pref-meta{color:#aaa;font-size:11px;white-space:nowrap;}
    .remove-btn{background:none;border:none;color:#ccc;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;}
    .remove-btn:hover{background:#fef2f2;color:#e53935;}
    .empty-msg{color:#999;font-size:14px;font-style:italic;padding:8px 0;}
    .tag-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}
    .tag-pill{display:inline-flex;align-items:center;gap:4px;background:#f0eeff;color:#4a3f8f;border-radius:20px;padding:6px 10px 6px 12px;font-size:13px;font-weight:500;transition:all .2s;}
    .tag-pill .tag-cat{font-size:10px;color:#8a7fc0;margin-right:2px;text-transform:uppercase;letter-spacing:.5px;}
    .tag-pill button{background:none;border:none;color:#a89ee0;cursor:pointer;font-size:15px;padding:0 2px;line-height:1;}
    .tag-pill button:hover{color:#e53935;}
    .suggestions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;}
    .chip{display:inline-flex;align-items:center;padding:7px 14px;background:#f8f7ff;border:1.5px solid #e0ddf5;border-radius:20px;font-size:13px;color:#6c63ff;cursor:pointer;transition:all .15s;font-weight:500;}
    .chip:hover{background:#ede9ff;border-color:#c4bfff;}
    .tag-input-row{display:flex;gap:8px;margin-top:8px;}
    .tag-input-row input{flex:1;}
    .tag-input-row .btn{width:48px;flex-shrink:0;font-size:20px;padding:0;}
    .job-card{background:#f8f7ff;border:1px solid #e8e6f0;border-radius:12px;padding:16px;margin-bottom:12px;}
    .job-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
    .job-name{font-weight:600;font-size:15px;color:#1a1a2e;}
    .job-prompt{font-size:13px;color:#666;line-height:1.4;margin-bottom:6px;}
    .job-schedule{font-size:12px;color:#999;}
    .job-schedule code{background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:11px;}
    .job-actions{display:flex;gap:8px;margin-top:10px;}
    .job-actions button{background:#f0f2f5;border:1px solid #ddd;color:#444;padding:6px 14px;border-radius:8px;font-size:13px;cursor:pointer;transition:all .15s;}
    .job-actions button:hover{background:#e8e6f0;}
    .job-form{margin-top:12px;padding-top:12px;border-top:1px solid #eee;}
    .form-row{display:flex;gap:8px;margin-top:12px;}
    .form-row .btn{width:auto;flex:1;}
    .input-hint{font-size:12px;color:#999;margin-top:4px;}
    .toggle{position:relative;display:inline-block;cursor:pointer;}
    .toggle input{position:absolute;opacity:0;width:0;height:0;}
    .toggle-track{display:block;width:44px;height:24px;background:#ddd;border-radius:12px;transition:background .2s;position:relative;}
    .toggle input:checked+.toggle-track{background:#6c63ff;}
    .toggle-thumb{position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.2);}
    .toggle input:checked+.toggle-track .toggle-thumb{transform:translateX(20px);}
    .gcal-btn{display:inline-flex;align-items:center;gap:8px;background:#fff;color:#444;border:1.5px solid #ddd;padding:12px 20px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:500;transition:all .15s;}
    .gcal-btn:hover{border-color:#4285f4;color:#4285f4;box-shadow:0 2px 8px rgba(66,133,244,.15);}
    .gcal-connected{display:flex;align-items:center;gap:8px;color:#2e7d32;font-weight:600;font-size:14px;margin-bottom:8px;}
    @keyframes fadeIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
    .card{animation:fadeIn .3s ease;}
  </style>
</head>
<body>
  <div class="header">
    <h1>${profile.name ? escapeHtml(profile.name) + '\u2019s Profile' : 'Set Up Your Profile'}</h1>
    <p>${escapeHtml(userId)}</p>
  </div>
  <div class="container">

  <div class="card">
    <div class="card-title">Profile</div>
    <form method="POST" action="/setup/${encodeURIComponent(userId)}?t=${encodeURIComponent(setupToken)}">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <label for="name">Name</label>
      <input type="text" id="name" name="name" value="${escapeHtml(profile.name || '')}" placeholder="e.g. Mike" required>
      <label for="location">Location</label>
      <input type="text" id="location" name="location" value="${escapeHtml(profile.location || '')}" placeholder="e.g. Austin, TX" required>
      <label for="timezone">Timezone</label>
      <select id="timezone" name="timezone">
        ${['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix','America/Anchorage','Pacific/Honolulu','Europe/London','Europe/Paris','Europe/Berlin','Asia/Tokyo','Asia/Seoul','Australia/Sydney'
        ].map(tz => `<option value="${escapeHtml(tz)}"${profile.timezone === tz ? ' selected' : ''}>${escapeHtml(tz.replace(/_/g,' '))}</option>`).join('')}
      </select>
      <label for="pronouns">Pronouns</label>
      <select id="pronouns" name="pronouns">
        ${[['','Prefer not to say'],['she/her','she/her'],['he/him','he/him'],['they/them','they/them'],['he/they','he/they'],['she/they','she/they'],['any','any pronouns']
        ].map(([val,label]) => `<option value="${escapeHtml(val)}"${profile.pronouns === val ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
      </select>
      <button type="submit" class="btn btn-primary" style="margin-top:18px;">Save Profile</button>
    </form>
    ${profile.updatedAt ? `<p style="color:#999;font-size:12px;margin-top:8px;text-align:center;">Last updated ${new Date(profile.updatedAt).toLocaleDateString()}</p>` : ''}
  </div>

  <div class="card">
    <div class="card-title">Tags</div>
    <p class="card-desc">Add tags so I can personalize things for you.</p>
    <div class="suggestions">
      <span class="chip" onclick="showTagInput('Favorite Sports Team','e.g. 49ers')">+ Sports Team</span>
      <span class="chip" onclick="showTagInput('Dietary Restriction','e.g. Vegetarian')">+ Diet</span>
      <span class="chip" onclick="showTagInput('Favorite Cuisine','e.g. Thai')">+ Cuisine</span>
      <span class="chip" onclick="showTagInput('Hobby','e.g. Rock climbing')">+ Hobby</span>
      <span class="chip" onclick="showTagInput('Music','e.g. R&amp;B')">+ Music</span>
      <span class="chip" onclick="showTagInput('Custom','Anything you want')">+ Custom</span>
    </div>
    <div id="tag-input-area" style="display:none;">
      <label id="tag-label">Tag</label>
      <div class="tag-input-row">
        <input type="text" id="tag-input" placeholder="Type here...">
        <button class="btn btn-primary" onclick="addTag()" style="font-size:22px;">+</button>
      </div>
    </div>
    <div class="tag-pills" id="tags-list">${tagsHtml || '<p class="empty-msg">No tags yet.</p>'}</div>
  </div>

  <div class="card">
    <div class="card-title">Personal Notes</div>
    <p class="card-desc">Markdown notes — restaurant lists, preferences, anything. Each note is like a mini document I'll reference in conversations.</p>
    <div id="notes-list">${(() => {
      const notes = Array.isArray(profile.notes) ? profile.notes : (profile.notes ? [{ id: 'migrated', title: 'Notes', content: profile.notes, updatedAt: new Date().toISOString() }] : []);
      if (notes.length === 0) return '<p class="empty-msg">No notes yet.</p>';
      return notes.map(n => `
        <div class="note-card" id="note-${escapeHtml(n.id)}" style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:12px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <input type="text" class="note-title" value="${escapeHtml(n.title || '')}" placeholder="Note title" style="background:transparent;border:none;color:#fff;font-weight:bold;font-size:15px;flex:1;padding:4px 0;">
            <button onclick="deleteNote('${escapeHtml(n.id)}')" style="background:none;border:none;color:#666;cursor:pointer;font-size:18px;padding:0 4px;" title="Delete">\u00d7</button>
          </div>
          <textarea class="note-content" style="width:100%;min-height:120px;background:#111;color:#e0e0e0;border:1px solid #222;border-radius:6px;padding:10px;font-family:'SF Mono',monospace;font-size:13px;resize:vertical;white-space:pre-wrap;">${escapeHtml(n.content || '')}</textarea>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
            <span style="color:#555;font-size:11px;">${n.updatedAt ? new Date(n.updatedAt).toLocaleDateString() : ''}</span>
            <button class="btn btn-primary" style="font-size:13px;padding:6px 14px;" onclick="saveNote('${escapeHtml(n.id)}')">Save</button>
          </div>
        </div>`).join('');
    })()}</div>
    <button class="btn btn-add" onclick="addNewNote()">+ Add Note</button>
    <script>
    function addNewNote(){
      const id='n'+Date.now();
      const html=\`<div class="note-card" id="note-\${id}" style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:12px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <input type="text" class="note-title" value="" placeholder="Note title (e.g. Restaurant List)" style="background:transparent;border:none;color:#fff;font-weight:bold;font-size:15px;flex:1;padding:4px 0;">
          <button onclick="deleteNote('\${id}')" style="background:none;border:none;color:#666;cursor:pointer;font-size:18px;padding:0 4px;" title="Delete">\u00d7</button>
        </div>
        <textarea class="note-content" style="width:100%;min-height:120px;background:#111;color:#e0e0e0;border:1px solid #222;border-radius:6px;padding:10px;font-family:'SF Mono',monospace;font-size:13px;resize:vertical;white-space:pre-wrap;" placeholder="Write your note in markdown..."></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:6px;">
          <button class="btn btn-primary" style="font-size:13px;padding:6px 14px;" onclick="saveNote('\${id}')">Save</button>
        </div>
      </div>\`;
      const emptyMsg=document.querySelector('#notes-list .empty-msg');
      if(emptyMsg)emptyMsg.remove();
      document.getElementById('notes-list').insertAdjacentHTML('beforeend',html);
      document.querySelector('#note-'+id+' .note-title').focus();
    }
    function saveNote(id){
      const card=document.getElementById('note-'+id);
      if(!card)return;
      const title=card.querySelector('.note-title').value.trim()||'Untitled';
      const content=card.querySelector('.note-content').value;
      fetch('/setup/${encodeURIComponent(userId)}/notes/'+encodeURIComponent(id)+'?t=${encodeURIComponent(setupToken)}',{
        method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({title,content})
      }).then(r=>r.json()).then(j=>{
        if(j.ok){const btn=card.querySelector('.btn-primary');btn.textContent='Saved!';setTimeout(()=>btn.textContent='Save',2000);}
      });
    }
    function deleteNote(id){
      if(!confirm('Delete this note?'))return;
      fetch('/setup/${encodeURIComponent(userId)}/notes/'+encodeURIComponent(id)+'?t=${encodeURIComponent(setupToken)}',{
        method:'DELETE'
      }).then(r=>r.json()).then(j=>{
        if(j.ok){const card=document.getElementById('note-'+id);if(card)card.remove();}
      });
    }
    </script>
  </div>

  <div class="card">
    <div class="card-title">What I Know About You</div>
    <p class="card-desc">Learned from our conversations. Tap \u00d7 to remove any.</p>
    <div id="prefs-list">${prefsHtml}</div>
  </div>

  <div class="card">
    <div class="card-title">Rules</div>
    <p class="card-desc">Strict instructions I always follow for you — these override my defaults.</p>
    <div id="rules-list">${rulesHtml}</div>
    <div class="tag-input-row" style="margin-top:12px;">
      <input type="text" id="rule-input" placeholder="e.g. never use bullet points" maxlength="200">
      <button class="btn btn-primary" onclick="addRuleFromPage()" style="width:48px;font-size:20px;flex-shrink:0;padding:0;">+</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Scheduled Jobs</div>
    <p class="card-desc">Recurring tasks that run on a schedule and send results to your DM.</p>
    <div id="jobs-list">${jobsHtml || ''}</div>
    <div id="job-form" style="display:none;" class="job-form">
      <input type="hidden" id="job-edit-id" value="">
      <label for="job-name">Job Name</label>
      <input type="text" id="job-name" placeholder="e.g. Morning Briefing">
      <label for="job-prompt">What should I do?</label>
      <textarea id="job-prompt" placeholder="e.g. Give me the latest AI news and developments"></textarea>
      <label for="job-freq">Schedule</label>
      <input type="text" id="job-freq" placeholder="e.g. daily at 8am">
      <p class="input-hint">Examples: daily at 9am, weekdays at 8:30am, monday at 10am, every 3 hours</p>
      <div class="form-row">
        <button class="btn btn-primary" onclick="saveJob()">Save Job</button>
        <button class="btn btn-secondary" onclick="cancelJobForm()">Cancel</button>
      </div>
    </div>
    <button class="btn btn-add" id="add-job-btn" onclick="showJobForm()">+ Add Job</button>
    <div style="margin-top:12px;">
      <p class="card-desc" style="margin-bottom:8px;">Quick templates:</p>
      <div class="suggestions">
        <span class="chip" onclick="prefillJob('Morning Briefing','Give me a morning briefing: top news, weather for my area, and anything on my calendar today.','daily at 8am')">Morning Briefing</span>
        <span class="chip" onclick="prefillJob('AI Pulse','What are the latest AI news and developments from the last few hours? Give me a concise bullet-point summary.','daily at 10am')">AI Pulse</span>
        <span class="chip" onclick="prefillJob('Weekly Meal Plan','Suggest a weekly meal plan based on my dietary preferences and favorite cuisines. Include a grocery list.','monday at 9am')">Weekly Meal Plan</span>
        <span class="chip" onclick="prefillJob('Concert Price Tracker','Check for upcoming concerts by my favorite Spotify artists within 50 miles of my location. For each show, get current ticket prices from multiple sources (StubHub, SeatGeek, VividSeats). Compare prices and highlight any deals under $100. Only show events in the next 3 months. If prices dropped since last check, flag them.','every 6 hours')">Concert Price Tracker</span>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Google Calendar</div>
    <p class="card-desc">Connect so I can check your calendar and coordinate events with friends.</p>
    ${profile.gcal_connected ? `<div class="gcal-connected"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Connected (${escapeHtml(profile.gcal_email)})</div>` : ''}
    ${googleConfigured ? `<a href="/auth/google/calendar/${encodeURIComponent(userId)}?t=${encodeURIComponent(gcalToken)}" class="gcal-btn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4285f4" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${profile.gcal_connected ? 'Reconnect' : 'Connect Google Calendar'}</a>` : '<p class="empty-msg">Google Calendar not configured on this server.</p>'}
  </div>

  <div class="card">
    <div class="card-title">Spotify</div>
    <p class="card-desc">Connect to auto-import your favorite artists. I'll use them to find concerts, ticket prices, and let you know when events are coming to your area.</p>
    ${profile.spotify_connected ? `<div class="gcal-connected"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Connected (${escapeHtml(profile.spotify_email || profile.spotify_user_id || '')})</div>` : ''}
    ${spotifyConfigured ? `<a href="/auth/spotify/${encodeURIComponent(userId)}?t=${encodeURIComponent(spotifyToken)}" class="gcal-btn" style="border-color:#1DB954;color:#1DB954;"><svg width="18" height="18" viewBox="0 0 24 24" fill="#1DB954"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>${profile.spotify_connected ? 'Reconnect' : 'Connect Spotify'}</a>` : '<p class="empty-msg">Spotify not configured on this server.</p>'}
  </div>

  <div class="card">
    <div class="card-title">Eight Sleep</div>
    <p class="card-desc">Connect your Eight Sleep smart mattress so I can control temperature, turn it on/off, and check status.</p>
    ${(() => { try { return require('./eight-sleep').hasCredentials(userId) ? '<div class="gcal-connected"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Connected</div>' : ''; } catch { return ''; } })()}
    <div id="eightsleep-form">
      <label for="eightsleep-email">Eight Sleep Email</label>
      <input type="email" id="eightsleep-email" placeholder="your@email.com">
      <label for="eightsleep-pass">Password</label>
      <input type="password" id="eightsleep-pass" placeholder="Your Eight Sleep password">
      <p class="input-hint">Credentials are encrypted and stored securely. Only you can access your bed.</p>
      <button class="btn btn-primary" style="margin-top:10px;" onclick="connectEightSleep()">Connect Eight Sleep</button>
    </div>
    <script>
    function connectEightSleep(){
      const email=document.getElementById('eightsleep-email').value;
      const pass=document.getElementById('eightsleep-pass').value;
      if(!email||!pass){alert('Enter email and password');return;}
      fetch('/setup/${encodeURIComponent(userId)}/eightsleep?t=${encodeURIComponent(setupToken)}',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email,password:pass})
      }).then(r=>r.json()).then(j=>{
        if(j.ok){
          document.getElementById('eightsleep-form').innerHTML='<div class="gcal-connected"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Connected!</div>';
        } else { alert(j.error||'Connection failed'); }
      });
    }
    </script>
  </div>

  </div>
<script>
const CSRF=${JSON.stringify(csrfToken)};
const UID=${JSON.stringify(encodeURIComponent(userId))};
let _tagCat='Custom';

function showTagInput(cat,ph){
  _tagCat=cat;
  document.getElementById('tag-label').textContent=cat;
  document.getElementById('tag-input').placeholder=ph;
  document.getElementById('tag-input').value='';
  document.getElementById('tag-input-area').style.display='block';
  document.getElementById('tag-input').focus();
}
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&document.activeElement.id==='tag-input')addTag();});

async function addTag(){
  const inp=document.getElementById('tag-input');
  const label=inp.value.trim();
  if(!label)return;
  const res=await fetch('/setup/'+UID+'/add-tag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label,category:_tagCat,_csrf:CSRF})});
  if(res.ok){
    const d=await res.json();
    if(d.ok&&d.tag){
      const list=document.getElementById('tags-list');
      if(list.querySelector('.empty-msg'))list.innerHTML='';
      const idx=list.children.length;
      const s=document.createElement('span');s.className='tag-pill';s.id='tag-'+idx;
      s.innerHTML='<span class="tag-cat">'+esc(d.tag.category)+'</span>'+esc(d.tag.label)+'<button onclick="removeTag('+idx+',\\''+esc(d.tag.label)+'\\')">\\u00d7</button>';
      list.appendChild(s);
      inp.value='';
    }
  }
}

async function removeTag(idx,label){
  const res=await fetch('/setup/'+UID+'/remove-tag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label,_csrf:CSRF})});
  if(res.ok){const el=document.getElementById('tag-'+idx);if(el)el.remove();}
}

async function removePref(idx,fact){
  if(!confirm('Remove "'+fact+'"?'))return;
  const res=await fetch('/setup/'+UID+'/remove-preference',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fact,_csrf:CSRF})});
  if(res.ok){const el=document.getElementById('pref-'+idx);if(el)el.remove();if(!document.querySelector('.pref'))document.getElementById('prefs-list').innerHTML='<p class="empty-msg">No preferences.</p>';}
}

async function addRuleFromPage(){
  const inp=document.getElementById('rule-input');
  const rule=(inp.value||'').trim();
  if(!rule)return;
  const res=await fetch('/setup/'+UID+'/add-rule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rule,_csrf:CSRF})});
  const d=await res.json();
  if(res.ok&&d.ok){
    const list=document.getElementById('rules-list');
    if(list.querySelector('.empty-msg'))list.innerHTML='';
    const idx=list.children.length;
    const div=document.createElement('div');div.className='pref';div.id='rule-'+idx;
    div.innerHTML='<span>'+esc(rule)+'</span><span class="pref-meta">today</span><button type="button" class="remove-btn" onclick="removeRule('+idx+',\\''+esc(rule)+'\\')">×</button>';
    list.appendChild(div);
    inp.value='';
  }else{alert(d.error||'Could not add rule');}
}

async function removeRule(idx,rule){
  if(!confirm('Remove this rule?'))return;
  const res=await fetch('/setup/'+UID+'/remove-rule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rule,_csrf:CSRF})});
  if(res.ok){const el=document.getElementById('rule-'+idx);if(el)el.remove();if(!document.querySelector('#rules-list .pref'))document.getElementById('rules-list').innerHTML='<p class="empty-msg">No rules set.</p>';}
}

function showJobForm(){document.getElementById('job-form').style.display='block';document.getElementById('add-job-btn').style.display='none';document.getElementById('job-edit-id').value='';document.getElementById('job-name').value='';document.getElementById('job-prompt').value='';document.getElementById('job-freq').value='';document.getElementById('job-name').focus();}
function cancelJobForm(){document.getElementById('job-form').style.display='none';document.getElementById('add-job-btn').style.display='block';}

function prefillJob(name,prompt,freq){showJobForm();document.getElementById('job-name').value=name;document.getElementById('job-prompt').value=prompt;document.getElementById('job-freq').value=freq;}

async function saveJob(){
  const id=document.getElementById('job-edit-id').value;
  const name=document.getElementById('job-name').value.trim();
  const prompt=document.getElementById('job-prompt').value.trim();
  const freq=document.getElementById('job-freq').value.trim();
  if(!name||!prompt||!freq){alert('Fill in all fields.');return;}
  const url=id?'/setup/'+UID+'/jobs/'+id:'/setup/'+UID+'/jobs';
  const method=id?'PUT':'POST';
  const res=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify({name,prompt,frequency:freq,_csrf:CSRF})});
  const d=await res.json();
  if(!res.ok){alert(d.error||'Failed');return;}
  cancelJobForm();location.reload();
}

async function toggleJob(id){
  await fetch('/setup/'+UID+'/jobs/'+id+'/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({_csrf:CSRF})});
}

function editJob(id){
  const card=document.getElementById('job-'+id);if(!card)return;
  showJobForm();
  document.getElementById('job-edit-id').value=id;
  document.getElementById('job-name').value=card.querySelector('.job-name')?.textContent||'';
  document.getElementById('job-prompt').value=card.querySelector('.job-prompt')?.textContent||'';
  document.getElementById('job-freq').value='';
}

async function deleteJob(id){
  if(!confirm('Delete this job?'))return;
  const res=await fetch('/setup/'+UID+'/jobs/'+id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({_csrf:CSRF})});
  if(res.ok){const el=document.getElementById('job-'+id);if(el)el.remove();}
}

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
</script>
</body>
</html>`);
});

app.post('/setup/:userId', express.urlencoded({ extended: false }), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);

  // F2: verify the setup access token is valid AND scoped to this userId.
  // The CSRF token below is the primary POST protection, but we also verify
  // the setup token to prevent URL manipulation attacks.
  const setupToken = typeof req.query.t === 'string' ? req.query.t : '';
  const _postAccessEntry = _setupAccessTokens.get(setupToken);
  if (!_postAccessEntry || _postAccessEntry.expiresAt <= Date.now() || !safeTokenEqual(_postAccessEntry.userId, userId)) {
    return res.status(403).send('Invalid or expired setup link — ask the bot for a new one.');
  }

  const { name, location, timezone, pronouns } = req.body;

  if ((name && name.length > 100) || (location && location.length > 200) || (timezone && timezone.length > 50) || (pronouns && pronouns.length > 30)) {
    return res.status(400).send('Input too long — please use shorter values.');
  }

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
      pronouns: (pronouns || '').trim() || null,
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
  <h1>Profile Saved!</h1>
  <p>Name: <strong>${escapeHtml((name||'').trim())}</strong><br>Location: <strong>${escapeHtml((location||'').trim())}</strong><br>Timezone: <strong>${escapeHtml(timezone||'')}</strong></p>
  <p style="margin-top:16px;color:#666;">Returning to setup...</p>
  <script>setTimeout(()=>history.back(),1500)</script>
</body></html>`);
});

// Remove a single preference from a user's profile (called from setup page JS)
app.post('/setup/:userId/remove-preference', express.json(), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { fact, _csrf } = req.body || {};
  if (!fact) return res.status(400).json({ error: 'fact required' });

  // Verify CSRF token (same one issued to the setup page)
  const entry = _setupCsrfTokens.get(userId);
  if (!entry || !_csrf || !safeTokenEqual(entry.token, _csrf) || entry.expiresAt < Date.now()) {
    return res.status(403).json({ error: 'invalid csrf' });
  }
  // Don't delete CSRF here — allow multiple removes from the same page load

  try {
    const { removePreference } = require('./user-profiles');
    const removed = removePreference(userId, fact);
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rules endpoints ──

app.post('/setup/:userId/add-rule', express.json(), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { rule, _csrf } = req.body || {};
  if (!rule || typeof rule !== 'string') return res.status(400).json({ error: 'rule required' });
  if (rule.length > 200) return res.status(400).json({ error: 'Rule must be under 200 characters' });
  if (!_verifyCsrf(userId, _csrf)) return res.status(403).json({ error: 'invalid csrf' });
  try {
    const { addRule } = require('./user-profiles');
    addRule(userId, rule);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/setup/:userId/remove-rule', express.json(), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { rule, _csrf } = req.body || {};
  if (!rule) return res.status(400).json({ error: 'rule required' });
  if (!_verifyCsrf(userId, _csrf)) return res.status(403).json({ error: 'invalid csrf' });
  try {
    const { removeRule } = require('./user-profiles');
    const removed = removeRule(userId, rule);
    res.json({ ok: true, removed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tag endpoints ──

function _verifyCsrf(userId, csrf) {
  const entry = _setupCsrfTokens.get(userId);
  return entry && csrf && safeTokenEqual(entry.token, csrf) && entry.expiresAt > Date.now();
}

app.post('/setup/:userId/add-tag', express.json(), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { label, category, _csrf } = req.body || {};
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'label required' });
  if (label.length > 100) return res.status(400).json({ error: 'Tag must be under 100 characters' });
  if (category && category.length > 50) return res.status(400).json({ error: 'Category must be under 50 characters' });
  if (!_verifyCsrf(userId, _csrf)) return res.status(403).json({ error: 'invalid csrf' });
  try {
    const { addTag } = require('./user-profiles');
    const tag = addTag(userId, label, category || 'Custom');
    if (!tag) return res.status(409).json({ error: 'duplicate or limit reached' });
    res.json({ ok: true, tag });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/setup/:userId/remove-tag', express.json(), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { label, _csrf } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label required' });
  if (!_verifyCsrf(userId, _csrf)) return res.status(403).json({ error: 'invalid csrf' });
  try {
    const { removeTag } = require('./user-profiles');
    const removed = removeTag(userId, label);
    res.json({ ok: true, removed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notes CRUD endpoints (personal markdown notes) ──
function _verifySetupAccess(req, res) {
  const userId = decodeURIComponent(req.params.userId);
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  const accessEntry = _setupAccessTokens.get(token);
  if (!accessEntry || accessEntry.expiresAt <= Date.now() || !safeTokenEqual(accessEntry.userId, userId)) {
    res.status(403).json({ error: 'invalid or expired token' });
    return null;
  }
  return userId;
}

// Save/update a single note
app.put('/setup/:userId/notes/:noteId', express.json(), (req, res) => {
  const userId = _verifySetupAccess(req, res);
  if (!userId) return;
  const noteId = req.params.noteId;
  const { title, content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  try {
    const { getProfile, setProfile } = require('./user-profiles');
    const profile = getProfile(userId) || {};
    let notes = Array.isArray(profile.notes) ? profile.notes
      : (profile.notes ? [{ id: 'migrated', title: 'Notes', content: profile.notes, updatedAt: new Date().toISOString() }] : []);
    const existing = notes.find(n => n.id === noteId);
    if (existing) {
      existing.title = (title || '').substring(0, 100);
      existing.content = content.substring(0, 10000);
      existing.updatedAt = new Date().toISOString();
    } else {
      if (notes.length >= 20) return res.status(400).json({ error: 'max 20 notes' });
      notes.push({ id: noteId, title: (title || '').substring(0, 100), content: content.substring(0, 10000), updatedAt: new Date().toISOString() });
    }
    setProfile(userId, { notes });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a note
app.delete('/setup/:userId/notes/:noteId', (req, res) => {
  const userId = _verifySetupAccess(req, res);
  if (!userId) return;
  const noteId = req.params.noteId;
  try {
    const { getProfile, setProfile } = require('./user-profiles');
    const profile = getProfile(userId) || {};
    let notes = Array.isArray(profile.notes) ? profile.notes : [];
    notes = notes.filter(n => n.id !== noteId);
    setProfile(userId, { notes });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Eight Sleep endpoint ──
app.post('/setup/:userId/eightsleep', express.json(), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  const accessEntry = _setupAccessTokens.get(token);
  if (!accessEntry || accessEntry.expiresAt <= Date.now() || !safeTokenEqual(accessEntry.userId, userId)) {
    return res.status(403).json({ error: 'invalid or expired token' });
  }
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const eightSleep = require('./eight-sleep');
    eightSleep.saveCredentials(userId, email, password);
    // Update profile to show connection status
    const { setProfile } = require('./user-profiles');
    setProfile(userId, { eightsleep_connected: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Job endpoints (scheduled DM tasks) ──

app.post('/setup/:userId/jobs', express.json(), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { name, prompt, frequency, _csrf } = req.body || {};
  if (!name || !prompt || !frequency) return res.status(400).json({ error: 'name, prompt, and frequency required' });
  if (!_verifyCsrf(userId, _csrf)) return res.status(403).json({ error: 'invalid csrf' });

  // Input length validation
  if (name.length > 100) return res.status(400).json({ error: 'Job name must be under 100 characters' });
  if (prompt.length > 2000) return res.status(400).json({ error: 'Job prompt must be under 2000 characters' });
  if (frequency.length > 100) return res.status(400).json({ error: 'Frequency must be under 100 characters' });

  // Job count limit (max 10 per user)
  const { getUserSchedules, addSchedule } = require('./schedules-storage');
  const existingJobs = getUserSchedules(userId).filter(s => s.type === 'dm-task');
  if (existingJobs.length >= 10) return res.status(400).json({ error: 'Maximum 10 scheduled jobs per user' });

  const { parseFrequency, validateMinInterval } = require('./parse-frequency');
  const parsed = parseFrequency(frequency);
  if (!parsed) return res.status(400).json({ error: 'Could not parse schedule. Try: "daily at 9am", "weekdays at 8:30am", "every 3 hours"' });
  if (!validateMinInterval(parsed.cron)) return res.status(400).json({ error: 'Schedule must be at least every 5 minutes' });

  let tz = 'America/Los_Angeles';
  try { const p = require('./user-profiles').getProfile(userId); if (p?.timezone) tz = p.timezone; } catch {}

  const sched = addSchedule({ userId, channelId: null, message: prompt, cronRule: parsed.cron, description: name, type: 'dm-task', cwd: null, timezone: tz });

  // Activate immediately
  try {
    const { registerJob } = require('./scheduler');
    registerJob(sched);
  } catch (err) { console.warn(`[jobs] Could not register job #${sched.id}: ${err.message}`); }

  res.json({ ok: true, job: sched });
});

app.put('/setup/:userId/jobs/:jobId', express.json(), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const jobId = parseInt(req.params.jobId, 10);
  const { name, prompt, frequency, _csrf } = req.body || {};
  if (!_verifyCsrf(userId, _csrf)) return res.status(403).json({ error: 'invalid csrf' });

  if (name && name.length > 100) return res.status(400).json({ error: 'Job name must be under 100 characters' });
  if (prompt && prompt.length > 2000) return res.status(400).json({ error: 'Job prompt must be under 2000 characters' });

  const fields = {};
  if (name) fields.description = name;
  if (prompt) fields.message = prompt;
  if (frequency) {
    const { parseFrequency, validateMinInterval } = require('./parse-frequency');
    const parsed = parseFrequency(frequency);
    if (!parsed) return res.status(400).json({ error: 'Could not parse schedule.' });
    if (!validateMinInterval(parsed.cron)) return res.status(400).json({ error: 'Schedule must be at least every 5 minutes' });
    fields.cronRule = parsed.cron;
  }

  const { updateSchedule } = require('./schedules-storage');
  const sched = updateSchedule(jobId, userId, fields);
  if (!sched) return res.status(404).json({ error: 'Job not found' });

  // Re-register cron
  try {
    const { cancelJob, registerJob } = require('./scheduler');
    cancelJob(jobId);
    if (sched.active) registerJob(sched);
  } catch {}

  res.json({ ok: true, job: sched });
});

app.delete('/setup/:userId/jobs/:jobId', express.json(), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const jobId = parseInt(req.params.jobId, 10);
  const { _csrf } = req.body || {};
  if (!_verifyCsrf(userId, _csrf)) return res.status(403).json({ error: 'invalid csrf' });

  const { removeSchedule } = require('./schedules-storage');
  const removed = removeSchedule(jobId, userId);
  if (!removed) return res.status(404).json({ error: 'Job not found' });

  try { const { cancelJob } = require('./scheduler'); cancelJob(jobId); } catch {}
  res.json({ ok: true });
});

app.post('/setup/:userId/jobs/:jobId/toggle', express.json(), (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const jobId = parseInt(req.params.jobId, 10);
  const { _csrf } = req.body || {};
  if (!_verifyCsrf(userId, _csrf)) return res.status(403).json({ error: 'invalid csrf' });

  const { toggleSchedule } = require('./schedules-storage');
  const sched = toggleSchedule(jobId, userId);
  if (!sched) return res.status(404).json({ error: 'Job not found' });

  try {
    const { cancelJob, registerJob } = require('./scheduler');
    if (sched.active) registerJob(sched);
    else cancelJob(jobId);
  } catch {}

  res.json({ ok: true, active: sched.active });
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
  // Don't delete token — user needs it to return to setup page after OAuth

  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(400).send('Google OAuth not configured on this server.');
  }
  try {
    _oauthReturnUrls.set(userId, `/setup/${encodeURIComponent(userId)}?t=${encodeURIComponent(setupToken)}`);
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
    const result = await googleAuth.handleCallback(code, state);
    const returnUrl = _oauthReturnUrls.get(result.userId);
    if (returnUrl) _oauthReturnUrls.delete(result.userId);
    const redirectScript = returnUrl
      ? `<script>setTimeout(()=>window.location.href=${JSON.stringify(returnUrl)},1500)</script>`
      : '';
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calendar Connected</title><style>body{font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;text-align:center;}</style></head><body><h1 style="color:#4285f4;">Calendar Connected!</h1><p>${escapeHtml(result.displayName)} (${escapeHtml(result.email)}) is now linked.</p><p style="color:#666;font-size:14px;">${returnUrl ? 'Returning to setup...' : 'You can close this tab.'}</p>${redirectScript}</body></html>`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.status(500).send(`<h2>Authorization failed</h2><p>${escapeHtml(err.message)}</p>`);
  }
});

// Reports channels with active Claude processes — used by Claude before self-rebuilding
app.get('/active-sessions', requireInternalToken, (req, res) => {
  try {
    const { channels } = require('./bot');
    const active = [];
    for (const [channelId, state] of channels) {
      if (state.busy || state.process) {
        active.push({ channelId, name: channelId });
      }
    }
    res.json({ active, count: active.length });
  } catch {
    res.json({ active: [], count: 0 });
  }
});

// ── F2: issue ephemeral setup access tokens ──────────────────────────────────
// ── Background task registry ─────────────────────────────────────────────────
// Claude Code registers tasks here so !btw can show them even when the bot
// itself isn't busy. Tasks are { id, description, startedAt }.
const _backgroundTasks = new Map();

app.post('/internal/background-task', requireInternalToken, (req, res) => {
  const { id, description } = req.body || {};
  if (!id || !description) return res.status(400).json({ error: 'id and description required' });
  _backgroundTasks.set(String(id), { id: String(id), description: String(description).substring(0, 200), startedAt: Date.now() });
  res.json({ ok: true });
});

app.delete('/internal/background-task/:id', requireInternalToken, (req, res) => {
  _backgroundTasks.delete(req.params.id);
  res.json({ ok: true });
});

app.get('/internal/background-tasks', requireInternalToken, (req, res) => {
  res.json({ tasks: [..._backgroundTasks.values()] });
});

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

// ── Concert ticket prices endpoint (plugin: concert-tracker) ─────────────────
// Called by Claude via curl when the user asks about concert ticket prices.
// Delegates to the concert-tracker plugin which calls the concert-scraper
// sidecar in parallel for all 5 sources. Safe to leave in even when the
// concert-scraper profile is not active — returns a helpful message instead.
app.post('/concerts/prices', requireInternalToken, async (req, res) => {
  const { artist, venue, date, city } = req.body || {};
  if (!artist) {
    return res.status(400).json({ error: 'artist is required' });
  }

  try {
    const plugin = require('./plugins/concert-tracker');
    const available = await plugin.isAvailable();
    if (!available) {
      return res.json({
        text: 'Concert scraper is not currently running. Start it with:\n  docker compose --profile concerts up -d\n\nThen retry your question.',
      });
    }

    const text = await plugin.getPrices(
      artist,
      venue || '',
      date || '',
      city || '',
    );
    res.json({ text });
  } catch (err) {
    console.error('[concerts/prices] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Per-user Google Calendar events ───────────────────────────────────────
// Bianca's system prompt was telling her "Google Calendar: connected" based
// on profile data, but there was no bridge for her to actually READ the
// user's calendar — the MCP tools `mcp__claude_ai_Google_Calendar__list_events`
// authenticate against Claude's hosted Google account, NOT the per-user
// OAuth tokens stored by the bot's setup flow. So she kept saying "you're
// not connected" despite `gcal_connected=true`. This endpoint fixes the
// gap — it takes the user's id (phone number for Signal), fetches events
// via the authenticated google-auth client, and returns a plain-text
// summary formatted for chat use.
app.post('/calendar/events', requireInternalToken, async (req, res) => {
  const { userId, fromDate, toDate, isGroupChat, timezone } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const tz = timezone || 'America/Los_Angeles';

  // FAIL-CLOSED privacy gate: event titles + locations are redacted UNLESS
  // the caller explicitly passes the strict boolean `false`. Absence of the
  // field, string "true"/"false", `null`, or any other value → treated as
  // group chat → redacted. This is defense-in-depth. The primary trust
  // boundary is in bot.js's tag handler (which clobbers the field with the
  // live chat context before calling this endpoint), but if any future
  // caller forgets to pass the flag or passes it loosely, we fail safe.
  //
  // Translation: you have to opt OUT of redaction, not opt IN.
  const redactTitles = (isGroupChat !== false);

  try {
    const googleAuth = require('./google-auth');
    const calendar = await googleAuth.getCalendarClient(userId);
    if (!calendar) {
      return res.json({
        text: 'Calendar not connected for this user. Run `!setup` and link Google Calendar.',
        connected: false,
      });
    }

    // Default to today in the user's timezone (falls back to Pacific).
    const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const todayStr = localNow.toISOString().slice(0, 10);
    const from = fromDate || todayStr;
    let to = toDate;
    if (!to) {
      const d = new Date(from + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 7);
      to = d.toISOString().slice(0, 10);
    }

    // timeMin / timeMax want full ISO datetimes in UTC. The from/to dates
    // are local dates in the user's timezone, so convert local midnight → UTC.
    function _localMidnightUTC(dateStr) {
      const probe = new Date(`${dateStr}T12:00:00Z`);
      const localStr = probe.toLocaleString('en-US', { timeZone: tz });
      const offsetMs = probe.getTime() - new Date(localStr).getTime();
      return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + offsetMs);
    }
    const timeMin = _localMidnightUTC(from).toISOString();
    // +1 day on the end so we include the entire `to` day.
    const endParts = to.split('-').map(Number);
    const nextDay = new Date(Date.UTC(endParts[0], endParts[1] - 1, endParts[2] + 1));
    const nextDayStr = nextDay.toISOString().slice(0, 10);
    const timeMax = _localMidnightUTC(nextDayStr).toISOString();

    const resp = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const events = resp.data.items || [];
    if (events.length === 0) {
      return res.json({
        text: `No events on calendar between ${from} and ${to}. Totally free.`,
        connected: true,
        count: 0,
      });
    }

    const lines = events.map(ev => {
      const start = ev.start?.dateTime || ev.start?.date || '';
      const end = ev.end?.dateTime || ev.end?.date || '';
      const title = ev.summary || '(no title)';
      const location = ev.location ? ` @ ${ev.location}` : '';
      const startTz = ev.start?.timeZone || tz;
      let when = start;
      if (ev.start?.dateTime) {
        try {
          const d = new Date(start);
          when = d.toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZone: startTz,
          });
          if (end && ev.end?.dateTime) {
            const de = new Date(end);
            const endTime = de.toLocaleString('en-US', {
              hour: 'numeric', minute: '2-digit', timeZone: startTz,
            });
            when += `–${endTime}`;
          }
        } catch {}
      } else if (ev.start?.date) {
        when = `${ev.start.date} (all day)`;
      }
      if (redactTitles) {
        return `• ${when}: Busy`;
      }
      return `• ${when}: ${title}${location}`;
    });

    res.json({
      text: [`Events ${from} → ${to}:`, ...lines].join('\n'),
      connected: true,
      count: events.length,
      events: events.map(ev => ({
        id: ev.id,
        title: redactTitles ? 'Busy' : (ev.summary || null),
        start: ev.start?.dateTime || ev.start?.date || null,
        end: ev.end?.dateTime || ev.end?.date || null,
        location: redactTitles ? null : (ev.location || null),
      })),
    });
  } catch (err) {
    console.error('[calendar/events] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email search (deterministic, server-side Gmail API) ──────────────────
// The MCP Gmail search_threads tool is non-deterministic — Claude picks the
// search query, and sometimes misses emails the user knows exist. This
// endpoint does a thorough server-side search with multiple query strategies
// to ensure reliable results. Claude can call this via curl as a backup
// when MCP search returns unexpected results.
app.post('/email/search', requireInternalToken, async (req, res) => {
  const { query, days = 30, userId } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required' });

  const targetUserId = userId || SIGNAL_OWNER;
  try {
    const googleAuth = require('./google-auth');
    const gmail = await googleAuth.getGmailClient(targetUserId);
    if (!gmail) {
      return res.json({ text: 'Gmail not connected. Run `!connect` to authorize.', results: [] });
    }

    const afterEpoch = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
    const queries = [];

    // Build multiple search strategies from the query
    const q = query.trim();
    queries.push(`${q} after:${afterEpoch}`);
    if (!q.startsWith('from:') && !q.startsWith('to:') && !q.startsWith('subject:')) {
      queries.push(`from:${q} after:${afterEpoch}`);
      queries.push(`subject:${q} after:${afterEpoch}`);
    }

    const seenIds = new Set();
    const allMessages = [];

    for (const searchQuery of queries) {
      try {
        const listRes = await gmail.users.messages.list({
          userId: 'me',
          q: searchQuery,
          maxResults: 20,
        });
        for (const msg of (listRes.data.messages || [])) {
          if (!seenIds.has(msg.id)) {
            seenIds.add(msg.id);
            allMessages.push(msg);
          }
        }
      } catch (err) {
        console.warn(`[email/search] query "${searchQuery}" failed: ${err.message}`);
      }
    }

    if (allMessages.length === 0) {
      return res.json({ text: `No emails found for "${q}" in the last ${days} days.`, results: [] });
    }

    // Fetch metadata for all found messages
    const results = await Promise.all(
      allMessages.slice(0, 30).map(async ({ id, threadId }) => {
        try {
          const msg = await gmail.users.messages.get({
            userId: 'me', id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
          });
          const headers = msg.data.payload?.headers || [];
          const h = (name) => headers.find(hdr => hdr.name.toLowerCase() === name.toLowerCase())?.value || '';
          return {
            messageId: id, threadId,
            from: h('From'), to: h('To'),
            subject: h('Subject'), date: h('Date'),
            snippet: msg.data.snippet || '',
            isUnread: (msg.data.labelIds || []).includes('UNREAD'),
          };
        } catch { return null; }
      })
    );

    const valid = results.filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));

    const lines = valid.map((e, i) => {
      const fromShort = (e.from.match(/^(.+?)\s*</) || [])[1]?.replace(/["']/g, '') || e.from.split('@')[0];
      const dateStr = new Date(e.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return `${i + 1}. ${fromShort} — "${e.subject}" (${dateStr})${e.isUnread ? ' [UNREAD]' : ''}`;
    });

    res.json({
      text: `Found ${valid.length} email(s) for "${q}":\n${lines.join('\n')}`,
      results: valid,
    });
  } catch (err) {
    console.error('[email/search] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email read thread (deterministic, server-side Gmail API) ─────────────
// Read a full email thread by threadId. Returns the full conversation.
app.post('/email/thread', requireInternalToken, async (req, res) => {
  const { threadId, userId } = req.body || {};
  if (!threadId) return res.status(400).json({ error: 'threadId is required' });

  const targetUserId = userId || SIGNAL_OWNER;
  try {
    const googleAuth = require('./google-auth');
    const gmail = await googleAuth.getGmailClient(targetUserId);
    if (!gmail) {
      return res.json({ text: 'Gmail not connected.', messages: [] });
    }

    const thread = await gmail.users.threads.get({
      userId: 'me', id: threadId, format: 'full',
    });

    const messages = (thread.data.messages || []).map(msg => {
      const headers = msg.payload?.headers || [];
      const h = (name) => headers.find(hdr => hdr.name.toLowerCase() === name.toLowerCase())?.value || '';

      // Extract plain text body
      let body = '';
      function extractText(part) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          body += Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) part.parts.forEach(extractText);
      }
      if (msg.payload) extractText(msg.payload);

      return {
        from: h('From'), to: h('To'), date: h('Date'),
        subject: h('Subject'),
        body: body.substring(0, 3000),
      };
    });

    const lines = messages.map(m => {
      const fromShort = (m.from.match(/^(.+?)\s*</) || [])[1]?.replace(/["']/g, '') || m.from;
      const dateStr = new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `--- ${fromShort} (${dateStr}) ---\n${m.body.trim()}`;
    });

    res.json({
      text: lines.join('\n\n'),
      messages,
      messageCount: messages.length,
    });
  } catch (err) {
    console.error('[email/thread] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email draft (deterministic, server-side Gmail API) ───────────────────
// Create a Gmail draft. More reliable than MCP create_draft.
app.post('/email/draft', requireInternalToken, async (req, res) => {
  const { to, subject, body, threadId, userId } = req.body || {};
  if (!to || !body) return res.status(400).json({ error: 'to and body are required' });

  const targetUserId = userId || SIGNAL_OWNER;
  try {
    const googleAuth = require('./google-auth');
    const gmail = await googleAuth.getGmailClient(targetUserId);
    if (!gmail) {
      return res.json({ success: false, error: 'Gmail not connected.' });
    }

    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject || '(no subject)'}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString('base64url');

    const draftBody = { message: { raw } };
    if (threadId) draftBody.message.threadId = threadId;

    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: draftBody,
    });

    res.json({
      success: true,
      draftId: draft.data.id,
      text: `Draft saved — "${subject || '(no subject)'}" to ${to}`,
    });
  } catch (err) {
    console.error('[email/draft] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Product search (DDG HTML scrape + search URLs) ────────────────────────
// Replaces Bianca's prior "I can't pull up Amazon links" refusals with a
// deterministic, multi-store product search that always returns at least
// the three store search URLs even if the DDG scrape comes back empty.
app.post('/products/search', requireInternalToken, async (req, res) => {
  const { query, wantPrices, stores } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    const plugin = require('./plugins/product-search');
    const text = await plugin.searchProducts(query, {
      wantPrices: !!wantPrices,
      stores: Array.isArray(stores) ? stores : null,
    });
    res.json({ text });
  } catch (err) {
    console.error('[products/search] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Weather (Open-Meteo) ──────────────────────────────────────────────────
// Structured JSON forecast, 16-day range, no API key. Replaces the
// brittle WebSearch/WebFetch scraping of weather.gov HTML that was
// returning wrong temperatures (monthly averages from content farms).
app.post('/weather', requireInternalToken, async (req, res) => {
  const { location, fromDate, toDate } = req.body || {};
  if (!location) {
    return res.status(400).json({ error: 'location is required' });
  }
  try {
    const plugin = require('./plugins/weather');
    const text = await plugin.getForecast(location, fromDate || null, toDate || null);
    res.json({ text });
  } catch (err) {
    console.error('[weather] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = parseInt(process.env.PORT, 10) || 3400;
const server = app.listen(PORT, () => {
  console.log(`Claude API wrapper listening on port ${PORT}`);

  // Keep Claude CLI OAuth token warm so users don't get "logged out" errors
  try {
    const { startTokenRefresh } = require('./token-refresh');
    startTokenRefresh();
  } catch (err) {
    console.error('[token-refresh] Failed to initialize:', err.message);
  }

  // Start on-call watchdog — proactive health checks with auto-remediation
  try {
    const { startWatchdog } = require('./oncall-watchdog');
    startWatchdog();
  } catch (err) {
    console.error('[oncall-watchdog] Failed to initialize:', err.message);
  }

  // After 30s of healthy running, snapshot code as last-known-good
  setTimeout(() => {
    try {
      const { snapshotGoodState } = require('./safe-rebuild');
      snapshotGoodState();
    } catch (err) {
      console.error('[safe-rebuild] Snapshot error:', err.message);
    }
  }, 30000);


  // Start the persistent Cloudflare tunnel for sandbox user subdomains.
  // The module auto-starts the tunnel on require() — we just need to load it.
  // Wrapped in try/catch so a missing credentials file doesn't crash the server.
  try {
    const sandboxTunnel = require('./sandbox-tunnel');

    app.post('/sandbox-tunnel/register', requireInternalToken, (req, res) => {
      const { name, port } = req.body;
      if (!name || !port) return res.status(400).json({ error: 'name and port required' });
      sandboxTunnel.registerPort(name, port);
      res.json({ ok: true, url: sandboxTunnel.getTunnelUrl(name) });
    });

    app.post('/sandbox-tunnel/unregister', requireInternalToken, (req, res) => {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      sandboxTunnel.unregisterPort(name);
      res.json({ ok: true });
    });

    app.get('/sandbox-tunnel/status', requireInternalToken, (_req, res) => {
      res.json(sandboxTunnel.getStatus());
    });
  } catch (err) {
    console.error('[sandbox-tunnel] Failed to initialize:', err.message);
  }
});

// Write clean-shutdown marker on SIGTERM/SIGINT so the next boot doesn't
// send a false crash notification. The entrypoint.sh trap may not fire
// reliably (bash traps don't run during foreground waits on some Docker
// setups), so we also handle it at the Node level.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { fs.writeFileSync(path.join('/home/node/.claude', '.clean-shutdown'), Date.now().toString()); } catch {}
  });
}

// Start Discord bot
const bot = require('./bot');
bot.start();

module.exports = { server };
