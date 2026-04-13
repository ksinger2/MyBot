# MyBot — Session Handoff (2026-04-12)

## Privacy, Spotify, security, encrypted journal, setup persistence

### Group chat privacy (new — critical)
Comprehensive privacy rules for group chats to prevent data leakage:

**Calendar privacy:**
- Group chats only show "X is busy on Saturday from 2-4pm" — never
  event titles, descriptions, or attendees
- Full calendar details only visible in private 1:1 DMs with that user
- `buildProfileContext()` accepts `isGroupChat` flag, injects PRIVACY
  rules into Claude's system prompt for group contexts

**Cross-group isolation:**
- Claude refuses to reveal/confirm existence of other group chats or DMs
- Won't discuss what groups someone is in, who they talk to, or what's
  said in other conversations
- Session journal context from other chats never leaked
- Each group treated as fully isolated

**Commands blocked in groups:**
- `!profile` → "DM me to view your profile"
- `!schedules` → "DM me to view yours"
- `!setup` → sends link via DM instead of posting publicly (was exposing
  phone numbers in group chat URLs)

**Files:** `bot.js`, `user-profiles.js`, `commands/profile.js`,
`commands/schedules.js`, `commands/setup.js`

### Signal mention fixes
- U+FFFC placeholder now replaced with `@name` from mention metadata
  (was stripped entirely, so "@Merrisa" became blank)
- `!onboard @person` resolves UUID-only mentions via contact cache
- Wizard sender matching resolves UUID→phone for reply detection
- Greeting uses mention name ("Hey Merrisa") not raw UUID

**Files:** `bot.js`, `adapters/signal.js`, `commands/onboard.js`

### Spotify integration
- Green "Connect Spotify" button on setup page (ephemeral token gated)
- On connect: fetches top 20 artists, auto-imports as tags ("Artist")
- `buildProfileContext()` includes artist list + concert discovery
- "Concert Alerts" job template on setup page
- Fixed Express route ordering (`/auth/spotify/callback` before `/:userId`)

**Setup:** Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`.
Add `https://mybot.backtoirl.com/auth/spotify/callback` in Spotify Dashboard.

### Encrypted session journal
- Prompt/result summaries encrypted at rest (AES-256-GCM, domain
  `mybot-session-journal`) — cross-session context maintained
- Auto-expires entries after 72 hours
- Backward-compatible with legacy plaintext entries

### Setup page session persistence
- Setup token valid for full 30-minute TTL (not consumed on page load)
- OAuth callbacks redirect back to setup via server-side return URL
- Profile save auto-redirects back

### Security hardening
- `deleteUser()` removes profile + tokens + schedules + cancels cron
- Max 10 DM jobs/user, min 5-minute cron interval
- Input validation on all setup endpoints
- `/app/data` mounted as named Docker volume
- Log redaction: group names, phone numbers, guild names
- `TOKEN_ENCRYPTION_KEY` required at startup (fail-closed)
- Prompt injection prevention in `buildProfileContext()`

### Setup page features
- Professional dark gradient header, purple accent, card-based layout
- Tags with suggestion chips, Scheduled DM jobs with CRUD/toggle
- Google Calendar + Spotify connect buttons
- `parseFrequency` extracted to shared module

### Earlier changes (same session)
- Discord streaming (edit-based, `fromDiscordStreaming()`)
- Signal read receipts (blue double-check on DM receive)
- Crash notification via Signal DM to owner
- Rebuild announcement removed
- Pending events persisted to disk
- BOT_PUBLIC_URL fix across setup/auth files
- Crash notification only on real crashes (rebuild writes clean-shutdown
  marker so intentional restarts don't trigger false alerts)
- Group chats: no auto-continue, no "Turn limit reached" messages, no
  debug/status output — regular users only see the bot's actual response

### Remaining improvements
- **Sidecar rebuilder** (designed, not built): Move Docker socket to
  separate `mybot-rebuilder` sidecar. Bot calls via HTTP POST. Removes
  Docker API access from bot container entirely.
- WhatsApp adapter not started
- Signal group joins failing ("Cannot find service ID for self")
- SIGNAL_OWNER_NUMBER not set in .env (hardcoded fallback)
- Job DM execution not yet tested with real scheduled fire
- Google OAuth app unverified (users click through warning)
