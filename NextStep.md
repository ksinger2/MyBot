# MyBot — Session Handoff (2026-04-12)

## Setup page redesign, tags, scheduled DM jobs, security hardening

### Setup page — professional redesign
Complete visual overhaul of `/setup/:userId` page:
- Dark gradient header (#1a1a2e → #2d2b55), purple accent (#6c63ff)
- Card-based layout with 14px border-radius, subtle shadows
- 48px touch targets, mobile-first (480px max-width)
- Smooth transitions on focus/hover, toggle switches for jobs

### Tags system (new)
User-curated identity labels stored in `profile.tags[]`:
- Suggestion chips: Sports Team, Diet, Cuisine, Hobby, Music, Custom
- Click chip → input appears with category label → Enter/+ to add
- Tags displayed as styled pills with × remove
- Stored as `{ label, category, addedAt }`, cap 30/user, deduped
- Included in Claude's system prompt via `buildProfileContext()`

**Files:** `user-profiles.js` (addTag/removeTag), `server.js` (endpoints + UI)

### Scheduled DM jobs (new)
Per-user recurring tasks that run through Claude and send results to DM:
- Create/edit/delete/toggle from the setup page
- Quick templates: Morning Briefing, AI Pulse, Weekly Meal Plan
- `type: 'dm-task'` in scheduler.js — detects Signal (phone) vs Discord
- Signal: `signalAdapter.sendLongMessage(phone, result.text)`
- Discord: `client.users.fetch(id)` → `createDM()` → send chunked text
- `parseFrequency` extracted to `parse-frequency.js` (shared module)

**Files:** `scheduler.js`, `schedules-storage.js`, `parse-frequency.js`, `server.js`

### Security hardening
From security audit:
- **Complete data deletion**: `deleteUser()` now removes profile + OAuth
  tokens + all schedules + cancels active cron jobs (was profile-only)
- **Job limits**: Max 10 DM jobs per user, minimum 5-minute cron interval
  (rejects `*/1`-`*/4` and `* * * * *`)
- **Input validation**: Tag label 100 chars, category 50, job name 100,
  job prompt 2000, frequency 100 — all validated server-side before storage
- **Data persistence**: `/app/data` mounted as named Docker volume
  (`bot-data`) so profiles, tokens, events survive container rebuilds

**Files:** `user-profiles.js`, `schedules-storage.js`, `scheduler.js`,
`parse-frequency.js`, `server.js`, `docker-compose.yml`

### Previous session changes (also 2026-04-12)
- Discord streaming (edit-based, `fromDiscordStreaming()`)
- Signal read receipts (blue double-check on DM receive)
- Crash notification via Signal DM to owner
- Rebuild announcement removed (only interrupted-work channels notified)
- Pending events persisted to `/app/data/pending-events.json`
- BOT_PUBLIC_URL fix in setup.js, google-auth.js, onboarding.js
- Google OAuth consent screen published (unverified, users click through)

### Remaining improvements (not blockers)
- WhatsApp adapter not started
- Signal group joins still failing ("Cannot find service ID for self")
  — needs re-linking bot as a linked device of a primary phone
- SIGNAL_OWNER_NUMBER not set in .env (using hardcoded fallback)
- Discord streaming could use edit-batching optimization for very long responses
- Job execution not yet tested end-to-end with a real scheduled fire
  (cron registration verified, DM routing code tested manually)
