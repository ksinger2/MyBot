# MyBot — Session Handoff (2026-04-12)

## Spotify, security, encrypted journal, setup session persistence

### Spotify integration
- Green "Connect Spotify" button on setup page (ephemeral token gated)
- On connect: fetches top 20 artists, auto-imports as tags (category "Artist")
- `buildProfileContext()` includes artist list + instructs Claude to find
  concerts/events in user's area
- "Concert Alerts" job template on setup page
- Redirect URI defaults to `BOT_PUBLIC_URL/auth/spotify/callback`

**Setup:** Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`.
Add redirect URI in Spotify Developer Dashboard.

### Encrypted session journal
Session journal now stores prompt/result summaries encrypted at rest
(AES-256-GCM, domain `mybot-session-journal`) instead of stripped.
- Cross-session context maintained — Claude sees what happened in
  previous sessions even when API sessions expire between messages
- Auto-expires entries after 72 hours
- Backward-compatible with legacy plaintext entries (re-encrypts on write)
- Raw file on disk is cipher text, not readable conversation content

### Setup page session persistence
- Setup access token no longer consumed on page load — valid for full
  30-minute TTL across all operations (save profile, connect OAuth, etc.)
- OAuth callbacks (Google Calendar, Spotify) store return URL server-side
  and redirect back to setup page after 1.5s
- Profile save also auto-redirects back to setup
- Fixed Express route ordering: `/auth/spotify/callback` defined before
  `/auth/spotify/:userId` so "callback" isn't matched as userId param

### Security hardening (from 3-agent audit)
- **Complete data deletion**: `deleteUser()` removes profile + OAuth
  tokens + schedules + cancels cron jobs
- **Job limits**: Max 10 DM jobs/user, min 5-minute cron interval
- **Input validation**: Tag 100 chars, category 50, job name 100, prompt
  2000, frequency 100
- **Data persistence**: `/app/data` mounted as named Docker volume
- **Log redaction**: Group names, phone numbers, Discord guild names
  redacted via `_redactPhone()`, `_redactId()`
- **Fail-closed encryption**: `TOKEN_ENCRYPTION_KEY` required at startup
- **Prompt injection prevention**: `buildProfileContext()` sanitizes
  user strings — strips `[ ] { } < >`, caps lengths

### Setup page features
- Professional dark gradient header, purple accent, card-based layout
- Tags with suggestion chips (Sports Team, Diet, Cuisine, Hobby, Music)
- Scheduled DM jobs with CRUD, toggle, quick templates (Morning Briefing,
  AI Pulse, Weekly Meal Plan, Concert Alerts)
- Preferences display with remove buttons
- Google Calendar + Spotify connect buttons
- `parseFrequency` extracted to shared module

### Earlier changes (same session)
- Discord streaming (edit-based, `fromDiscordStreaming()`)
- Signal read receipts (blue double-check on DM receive)
- Crash notification via Signal DM to owner
- Rebuild announcement removed
- Pending events persisted to disk
- BOT_PUBLIC_URL fix across setup/auth files

### Remaining improvements
- **Sidecar rebuilder** (designed, not built): Move Docker socket to
  separate `mybot-rebuilder` sidecar. Bot calls via HTTP POST. Removes
  Docker API access from bot container entirely.
- WhatsApp adapter not started
- Signal group joins failing ("Cannot find service ID for self")
- SIGNAL_OWNER_NUMBER not set in .env (hardcoded fallback)
- Job DM execution not yet tested with real scheduled fire
- Google OAuth app unverified (users click through warning)
