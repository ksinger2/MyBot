# MyBot — Session Handoff (2026-04-14)

## Spotify artist refresh — new sources + silent-failure fix

### The bug
Artist import was missing favorites. Two issues:
1. Every section of the import wrapped API calls in empty `catch {}`, so
   a single HTTP blip silently dropped an entire category without any log.
2. Only pulled from 4 sources — top/followed/liked/albums — missed
   artists that only live in playlists, Daily Mix, or recently-played.

### What changed
- `spotify-auth.js` — rewrote `importUserArtists()` (old `refreshArtists`
  is now an alias for back-compat with the `/spotify/refresh-artists`
  HTTP endpoint in `server.js`). Changes:
  - Errors per section are now *captured* and returned in `result.errors`
    instead of being swallowed — partial failures are visible.
  - Wider pagination caps: liked tracks 500→2000, saved albums 200→1000,
    followed-artists pages 10→20.
  - **Two new sources**: `me/player/recently-played` (last 50 plays) and
    `me/playlists` → `playlists/{id}/tracks` (first 40 playlists, 500
    tracks each, only requests `fields=items(track(artists(name))),next`
    to bound payload size).
  - Per-source counters (`top/followed/liked/albums/recent/playlists`)
    so we can see which source contributed what.
  - Logs full summary via `console.log` in addition to returning it.
- `commands/refreshartists.js` (new) — Signal DM command that runs
  `importUserArtists(phone)` and replies with counts + source breakdown
  + any errors. Aliases: `!refreshspotify`, `!repullartists`,
  `!reimportartists`.
- Container rebuilt.

### How to use
```
!refreshartists
```
Replies with something like:
> Done. 312 artists total (+174 new).
> Sources: top=142, followed=203, liked=187, albums=64, recent=18, playlists=487 (794 unique).

If a section fails, the error shows up in the reply too, which is how we
diagnose "favorite artist missing" going forward.

### Why this matters
The first run only returned 138 artists for Karen, and two artists she
listens to heavily were missing. Spotify's `me/top/artists` has known
flakiness with Discover Weekly / Daily Mix / radio autoplay — those
listens don't always show up in the top-artists endpoint. Adding
`recently-played` + `playlists` catches them.

---

# MyBot — Session Handoff (2026-04-13)

## Group features, flight tracker, mention fixes, no-output fix

### Signal group maxTurns increased (3 → 8)
- Group chats had `maxTurns: 3` which was too low — Claude would exhaust
  turns on ToolSearch/tool fetching before producing a response
- Increased to 8, enough for tool fetches + a useful reply

**Files:** `bot.js` (line ~2107)

### *(No output)* messages eliminated
- Bot was sending `*(No output)*` to users when Claude produced no text
  (common with low turn limits or tool-only runs)
- Now: if text is empty + hit turn limit → sends "I ran out of turns"
- If text is empty + no turn limit → silently skips (no placeholder)
- Fixed in all three code paths: Discord `sendLongMessage()`, Signal
  non-streamed path, and Discord adapter `sendLongMessage()`

**Files:** `bot.js` (lines ~709, ~1658, ~2152), `adapters/discord.js` (line ~124)

### Flight sharer (new feature)
- When a user shares a flight image (boarding pass, confirmation, itinerary)
  in a group chat, Claude reads the image and extracts flight details
- Automatically creates a travel block calendar event for ALL group members
  so they know the person is traveling
- Schedules a "have a safe flight @name" message 2h before departure
- Active flights injected into group context so users can ask "is Karen's
  flight on time?" and Claude will WebSearch the flight number
- Flights persisted to `/app/data/flights.json`, safe-flight jobs survive
  restarts via `restoreFlightJobs()` on boot
- 30-day auto-prune, deduplication by flight number + traveler + departure

**Files:** `flight-tracker.js` (new), `bot.js`, `system-prompt.js`

### Group notes & DM reminders (new feature)
- Claude detects action items in group chats (questions, shared content,
  tasks assigned) and tags them with `[NOTE: @TargetName description]`
- Notes stored in `/app/data/group-notes.json` (encrypted at rest, AES-256-GCM)
- Active notes injected into group prompt context so Claude can resolve them
  with `[RESOLVE_NOTE: <id>]`
- Reminder loop checks every hour, sends DM nudges to users with pending
  notes (max 3 reminders, 4h apart, 7-day expiry)
- Tags stripped from user-visible output (same pattern as `[LEARNED:]`)
- System prompt updated with GROUP NOTES instructions

**Files:** `group-notes.js` (new), `bot.js`, `system-prompt.js`

### Signal mention resolution (major fix)
- Contacts without phone numbers (UUID-only, like Merrisa) now resolve
  correctly — added `_uuidToName` cache from signal-cli `profile.given_name`
- Three-layer resolution: signal-cli profile name → UUID→phone→user-profile → fallback
- Raw @UUID patterns in text (e.g. `@59237aa4-...`) auto-replaced with names
- Outgoing messages auto-resolve `@Name` to proper Signal mentions (U+FFFC +
  mentions array) so recipients see names as saved in their contacts
- `phoneToUuid()` reverse lookup and `resolveUuidToName()` added to adapter

**Files:** `adapters/signal.js`, `bot.js`

### `!remember` multi-user + perspective flip
- `!remember @Merrisa and I like bowling` now stores on BOTH profiles
- Karen sees: `@Merrisa and I like bowling`
- Merrisa sees: `@Karen and I like bowling` (perspective-flipped)
- Confirmation shows resolved names, not UUIDs

**Files:** `commands/remember.js`

### *(No output)* messages eliminated
- Bot no longer sends `*(No output)*` placeholder to users
- If text is empty + hit turn limit → "I ran out of turns" message
- If text is empty + no turn limit → silently skip
- Fixed in Discord `sendLongMessage()`, Signal path, and Discord adapter

**Files:** `bot.js`, `adapters/discord.js`

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
