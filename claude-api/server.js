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
