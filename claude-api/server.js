const express = require('express');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());

app.post('/ask', (req, res) => {
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
app.post('/imagine', async (req, res) => {
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
    const fs = require('fs');
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
app.post('/remind', async (req, res) => {
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

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

app.post('/signal/webhook', express.json({ limit: '5mb' }), (req, res) => {
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
        adapter._handleIncoming(envelope);
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
    res.send(`<h2>Spotify Connected!</h2><p>${displayName} (${email || 'no email'}) is now linked. You can close this tab.</p>`);
  } catch (err) {
    console.error('Spotify OAuth callback error:', err.message);
    res.status(500).send(`<h2>Spotify authorization failed</h2><p>${err.message}</p>`);
  }
});

// ── Signal user onboarding setup page ────────────────────────────────────────
// Users tap a link generated by !setup, fill in their name/location, and
// connect Google Calendar — all from their phone browser.
app.get('/setup/:userId', (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  // Load existing profile to pre-fill the form
  let profile = {};
  try { profile = require('./user-profiles').getProfile(userId) || {}; } catch {}

  const calConnected = profile.gcal_connected
    ? `<p style="color:#4caf50;font-weight:bold;">✓ Google Calendar connected (${profile.gcal_email})</p>`
    : '';

  const googleBtn = googleConfigured
    ? `<a href="/auth/google/calendar/${encodeURIComponent(userId)}" style="display:inline-block;background:#4285f4;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:16px;">Connect Google Calendar</a>`
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
  <p class="sub">Phone: ${userId}</p>

  <div class="section">
    <form method="POST" action="/setup/${encodeURIComponent(userId)}">
      <label for="name">Your Name</label>
      <input type="text" id="name" name="name" value="${profile.name || ''}" placeholder="e.g. Mike" required>

      <label for="location">Your City / Location</label>
      <input type="text" id="location" name="location" value="${profile.location || ''}" placeholder="e.g. Austin, TX" required>

      <label for="timezone">Timezone</label>
      <select id="timezone" name="timezone">
        ${[
          'America/New_York','America/Chicago','America/Denver','America/Los_Angeles',
          'America/Phoenix','America/Anchorage','Pacific/Honolulu',
          'Europe/London','Europe/Paris','Europe/Berlin','Asia/Tokyo','Asia/Seoul','Australia/Sydney'
        ].map(tz => `<option value="${tz}"${profile.timezone === tz ? ' selected' : ''}>${tz.replace('_',' ')}</option>`).join('')}
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
  const { name, location, timezone } = req.body;
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
  <p>Name: <strong>${(name||'').trim()}</strong><br>Location: <strong>${(location||'').trim()}</strong><br>Timezone: <strong>${timezone||''}</strong></p>
  <p style="margin-top:32px;color:#666;">You can close this tab. Come back to connect Google Calendar if you haven't already.</p>
  <a href="/setup/${encodeURIComponent(userId)}" style="display:inline-block;margin-top:16px;color:#4285f4;">Back to setup</a>
</body></html>`);
});

// Google Calendar OAuth — phone-number-aware (works for Signal users)
app.get('/auth/google/calendar/:userId', async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(400).send('Google OAuth not configured on this server.');
  }
  try {
    const googleAuth = require('./google-auth');
    const authUrl = googleAuth.getAuthUrl(userId);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// Google OAuth callback for multi-user calendar access
app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state parameter.');
  try {
    const googleAuth = require('./google-auth');
    const { email, displayName } = await googleAuth.handleCallback(code, state);
    res.send(`<h2>Connected!</h2><p>${displayName} (${email}) is now linked to your Discord account. You can close this tab.</p>`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.status(500).send(`<h2>Authorization failed</h2><p>${err.message}</p>`);
  }
});

// Reports channels with active Claude processes — used by Claude before self-rebuilding
app.get('/active-sessions', (req, res) => {
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
