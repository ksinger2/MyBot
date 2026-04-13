# MyBot — Session Handoff (2026-04-12)

## Spotify OAuth, security hardening, session persistence

### Spotify integration (new)
Users can connect Spotify from the setup page to auto-import their
favorite artists as tags. Used for concert/event discovery.

- Green "Connect Spotify" button on setup page (same security pattern
  as Google Calendar — ephemeral token gated)
- On connect: fetches top 20 artists via Spotify API, auto-imports as
  tags with category "Artist"
- `buildProfileContext()` includes artist list + instructs Claude to
  proactively mention upcoming concerts in user's area
- "Concert Alerts" job template: weekly search for shows by favorite
  artists with ticket prices
- Spotify redirect URI defaults to `BOT_PUBLIC_URL` + `/auth/spotify/callback`

**Files:** `spotify-auth.js`, `server.js`, `user-profiles.js`, `docker-compose.yml`

**Setup required:** Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`
in `.env`. Add redirect URI `https://mybot.backtoirl.com/auth/spotify/callback`
in Spotify Developer Dashboard.

### Security hardening (from 3-agent audit)

**Fixes shipped:**
- **Complete data deletion**: `deleteUser()` now removes profile + OAuth
  tokens + all schedules + cancels active cron jobs
- **Job limits**: Max 10 DM jobs/user, min 5-minute cron interval
- **Input validation**: Tag 100 chars, category 50, job name 100, prompt
  2000, frequency 100 — all validated server-side
- **Data persistence**: `/app/data` mounted as named Docker volume
- **Log redaction**: Group names, phone numbers, Discord guild names all
  redacted in container logs (uses `_redactPhone()`, `_redactId()`)
- **Fail-closed encryption**: `TOKEN_ENCRYPTION_KEY` required at startup
  (server refuses to start if unset)
- **Prompt injection prevention**: User-controlled strings in
  `buildProfileContext()` sanitized — strips `[ ] { } < >`, caps lengths
- **Session journal stripped**: No longer stores prompt/response content,
  only metadata (timestamp, cwd, turnCount, resultLength)

### Setup page session persistence
- Setup token no longer consumed on GET — stays valid for full 30-minute
  TTL so users can connect Google Calendar, Spotify, save profile, add
  tags, and create jobs all in one session
- Google Calendar, Spotify, and profile save success pages auto-redirect
  back to setup page after 1.5s
- Fixed Express route ordering: `/auth/spotify/callback` now before
  `/auth/spotify/:userId` so "callback" isn't matched as a userId

### Setup page features (from earlier in session)
- Professional dark gradient header, purple accent, card-based layout
- Tags section with suggestion chips (Sports Team, Diet, Cuisine, etc.)
- Scheduled DM jobs with CRUD, toggle, quick templates
- Preferences display with remove buttons
- `parseFrequency` extracted to shared module

### Previous session changes (also 2026-04-12)
- Discord streaming (edit-based, `fromDiscordStreaming()`)
- Signal read receipts (blue double-check on DM receive)
- Crash notification via Signal DM to owner
- Rebuild announcement removed (only interrupted-work channels notified)
- Pending events persisted to `/app/data/pending-events.json`
- BOT_PUBLIC_URL fix in setup.js, google-auth.js, onboarding.js

### Remaining improvements
- **Sidecar rebuilder** (planned): Move Docker socket to a separate
  `mybot-rebuilder` sidecar container. Bot calls it via HTTP POST
  instead of spawning containers directly. Bot container loses docker
  socket entirely. Reduces attack surface from "full Docker API" to
  "HTTP POST to trusted sidecar." Architecture designed, not yet built.
- WhatsApp adapter not started
- Signal group joins still failing ("Cannot find service ID for self")
- SIGNAL_OWNER_NUMBER not set in .env (using hardcoded fallback)
- Job execution not yet tested with a real scheduled fire (cron
  registration verified, DM routing code reviewed)
- Google OAuth app unverified (users click through "unsafe" warning)
