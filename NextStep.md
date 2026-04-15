# MyBot — Session Handoff (2026-04-14, late session)

## Privacy hardening + deterministic concert tracker + auth refactor

This was a security-focused session triggered by a real privacy incident.
Karen reported that Bianca had broadcast two users' Google Calendar event
titles (including a psychiatrist appointment and a vet appointment with a
full street address) into a Signal group chat. Root cause was that calendar
privacy depended on a **prompt instruction** telling Claude not to leak —
which Claude ignored. The user's standing rule going forward:

> "These sorts of security implications and also feature behavior and bot
> behavior need to be as deterministic as possible so this NEVER happens
> again."

CLAUDE.md's Determinism Rule is now the contract for every privacy-sensitive
feature: **if removing a prompt instruction would change the security
outcome, the design is wrong.** Privacy must be enforced in code.

### Commits landed this session
```
47a74f1  chore: gitignore operator-only cloudflared tunnel scripts
f1eed60  fix: strip sender's full profile from group prompts + LEARNED PII filter
d3bd093  feat: privacy hardening + deterministic concert tracker + weather/product/calendar plugins
```
Plus one more (this entry + auth hardening + wizard fix) coming after this
NextStep update.

### Theme 1 — Calendar leak fix (the original incident)

**Server side (`claude-api/server.js`, `/calendar/events`):**
- Added `redactTitles = (isGroupChat !== false)` — **fail-CLOSED**. Any falsy
  value, missing flag, string `"true"`/`"false"`, or anything other than the
  strict boolean `false` → titles + locations replaced with `"Busy"`. You
  must opt OUT of redaction explicitly.
- Verified end-to-end with 5 attack tests: omitted flag, `false` (bool),
  `"false"` (string), `""` (empty — the actual Claude exploit), and a
  control DM call. All pass against Karen's real calendar (19 events).

**Tag handler (`bot.js [CALENDAR:]`):**
- Parses Claude's params first, **THEN** clobbers `params.userId =
  msg.senderId` and `params.isGroupChat = !!isGroupChat`. Closes the
  attack where Claude could emit `[CALENDAR: isGroupChat=""]` to bypass
  redaction. Order matters — the clobber MUST run after the parse loop.

### Theme 2 — Sender profile leak in groups (the audit's CRITICAL find)

A determinism+privacy audit Explore agent found that even after the
calendar fix, `buildProfileContext(sender, isGroupChat=true)` was still
injecting the sender's **entire** profile into the group prompt: location,
timezone, calendar email, Spotify favorite artists, tags, preferences
("vegetarian, allergic to shellfish"), STRICT USER RULES, Eight Sleep
side, and **up to 5,000 chars of personal NOTES**. The only thing
protecting any of it was a prompt instruction — same broken pattern.

**Fix (`claude-api/user-profiles.js`):**
- `buildProfileContext` now short-circuits when `isGroupChat=true` and
  returns ONLY: name, pronouns, and connection FLAGS (so the
  `[CALENDAR:]` / `[EIGHTSLEEP:]` / concert / product tag handlers still
  work). All personal data is **physically absent** from the prompt.
  Claude cannot leak what it never sees.
- Verified: DM context = 11,025 chars, group context = 1,144 chars.
  12/12 privacy assertions pass against Karen's real profile (no
  location, timezone, tags, preferences, rules, notes, favorite artists,
  Eight Sleep side, or calendar email leaks into the group blob).

### Theme 3 — `[LEARNED:]` PII filter (covert storage channel closed)

`[LEARNED:]` was writing arbitrary strings to `addPreference()` with no
validation. Prompt injection or model drift could persist credit cards,
SSNs, passwords, or full appointment text into the preferences table.

**Fix (`bot.js`):**
- 200-char hard cap.
- Regex deny-list: card numbers (13–19 digit runs), SSN (`ddd-dd-dddd`),
  CVV/CVC, secret keywords (`password|passcode|secret|api key|access token|pin:`),
  routing numbers.
- Rejected facts log a warning **and** DM the user that nothing was
  stored, so they know not to retry blindly.
- 12/12 PII filter tests pass (initial trailing-`\b` regex bug fixed:
  `pin: 1234` is non-word↔non-word at the colon-space boundary, so the
  trailing `\b` was dropped from the alternation).

### Theme 4 — Deterministic concert tracker (was hallucinating shows)

Earlier in the session, a separate engineering agent traced a critical
bug: Bianca was DMing concert listings that included shows by **dead
artists** (Prince, David Bowie, etc.). Root cause: scheduled
"Concert Price Tracker" jobs stored a free-text prompt that was fed to
Claude with no Ticketmaster pre-fetch. Claude WebSearched, hallucinated,
and shipped fabricated shows.

**New `claude-api/plugins/concert-tracker/find-shows.js`** — single source
of truth for "given artists + location, what real shows exist on
Ticketmaster?". Pure data in, pure data out. Two strict defenses:
- **Strict attraction-name match.** TM keyword search returns "Prince
  Royce" and "Prince Daddy & the Hyena" for a "Prince" query. The
  filter now requires an exact normalized match against TM's
  `_embedded.attractions[*].name`. Drops events with no attractions
  list rather than fall back to fuzzy matching.
- **Composite `(date | venueName)` dedup.** TM exposes the same show as
  multiple ticket-tier event IDs (regular vs. Platinum at Fenway).
  Same date + same venue name = one show.

**`commands/concerts.js`** — refactored to call `findUpcomingShows()`.
Display layer only.

**`scheduler.js`** — new `runConcertTrackerJob()`. The cron-fired
schedule path now: `getProfile → curated artist list → findUpcomingShows
→ _formatConcertTrackerMessage → _sendUserMessage`. **Claude is never
invoked in this loop.** Honest empty-state DMs ("no upcoming shows
within 50 mi"). Threshold alerts use TM face-value `priceRanges` — no
external scrapers needed.

**Startup safeguard + dispatch hard-stop**: any legacy "Concert Price
Tracker" schedule lacking `subtype === 'concert-tracker'` is force-
disabled at startup. The dispatch handler also rejects them. Even if a
user toggles the active flag back on, they cannot fire.

**`schedules-storage.js`** — `addSchedule()` and `updateSchedule()`
accept new `subtype` and `payload` fields.

**`wizards/concert-tracker.js`** — `onComplete` now writes a structured
payload (`{kind, useCuratedList, location, radiusMiles, lookAheadMonths,
priceThresholds, perArtistLimit}`) and a sentinel message. Dedupes any
prior concert-tracker schedules for the user before adding the new one.
Registers the cron in-memory immediately (fixes the "schedule doesn't
fire until next restart" UX bug). Cancels in-memory cron on removed
dupes.

**Verified end-to-end:** 6 artists searched (Tim McGraw, Sade,
Tame Impala, Doja Cat, Sabrina Carpenter, Lily Allen, Prince, Bowie).
4 returned real Boston-area shows (Tame Impala @ TD Garden 2026-07-28,
Tim McGraw @ Fenway 2026-07-30, Lily Allen @ MGM Music Hall 2026-09-04,
Doja Cat @ TD Garden 2026-11-23). 4 returned zero (correct: dead or not
touring Boston). Real ticketmaster.com URLs in output.

**Action: 5 paused legacy schedules deleted**: #9, #12, #14, #15, #16
(both Karen and the Boston user). They were paused first, then removed
from the JSON store with `cancelJob()` cleaning up the in-memory cron.
Users must re-run `!concerttracker` to recreate with the new payload
format.

### Theme 5 — Wizard `onCancel` save chain fix

After Karen reported `!concerts` ignoring her wizard-curated list, an
engineering agent traced it: the **Discord** `messageCreate` handler was
nulling `state.wizard = null` directly without going through
`cancelWizard()`, so `flushOnCancel` never ran on the Discord path. The
Signal silent-cancel path was already correct.

**Fix (`bot.js` Discord branch):** now `await cancelWizard(state, message,
{silent: true})` properly. The wizard's `onCancel` hook saves the curated
list before the wizard is destroyed.

**Paper-trail logging added** (`wizards/concert-tracker.js` `onCancel` +
`onComplete`): both hooks now read back from disk after `setProfile`
and log `[concert-tracker] early-exit save: N/M artists persisted…`.
If `setProfile` ever silently no-ops, the saved count won't match the
input count and the regression surfaces in the logs immediately.

**3 end-to-end tests pass**: Signal flow, Discord-shaped flow, and
`!concerts` actually reading the curated 60 (not falling back to raw
Spotify tags).

**The "30 of 171" mystery resolved**: stale pre-rebuild output.
`MAX_UNCURATED_FANOUT` is `100` everywhere in the current tree, never
shadowed. The string template lives in exactly one place. The user saw
it from a container running an older image.

### Theme 6 — Auth hardening: kill Claude's access to `INTERNAL_API_TOKEN`

The audit's medium-severity Vector 8: every endpoint on the bot's
internal API was protected by a single shared secret in `INTERNAL_API_TOKEN`,
and the system prompt **literally told Claude** to `curl … -H "X-Internal-Token:
$INTERNAL_API_TOKEN"`. So in DMs, Claude had Bash, had the token, and
could call any internal endpoint with arbitrary parameters — bypassing
the parse-then-clobber pattern that bot.js uses for the tag-handler path.
Concretely: Claude in a DM could curl `/calendar/events?userId=+1otheruser`
and get back another user's calendar.

**The right fix is to never give Claude the token.** All Claude data
access goes through tag handlers in bot.js (which clobber sensitive
params with trusted values). The curl pattern dies.

**New `claude-api/internal-token.js`:**
- Captures `process.env.INTERNAL_API_TOKEN` into a closure at module
  load (this module is `require`'d at the top of bot.js and server.js).
- Immediately `delete`s `process.env.INTERNAL_API_TOKEN`.
- Exposes `getInternalToken()` as the only handle. The closure is the
  ONLY way to read the token — anywhere in the bot process.

**`runner.js`:** the Claude CLI subprocess spawn now omits
`INTERNAL_API_TOKEN` from the explicit env block. Comment marker says
"do not re-add". A startup probe (re-run via the same env builder)
verified `CLAUDE_ENV: UNSET`.

**Every internal caller migrated** from `process.env.INTERNAL_API_TOKEN`
to `require('./internal-token').getInternalToken()`:
- `bot.js`, `server.js`
- `commands/btw.js`, `commands/prices.js`, `commands/product.js`,
  `commands/setalert.js`, `commands/setup.js`
- `flight-tracker.js`, `wizards/onboarding.js`, `smoke-test.js`
- `plugins/weather/index.js`, `plugins/product-search/index.js`,
  `plugins/concert-tracker/index.js` — all `*_INSTRUCTIONS` strings:
  curl blocks **deleted**, tag form only, with explicit "There is NO
  curl alternative — you do not have INTERNAL_API_TOKEN".
- `system-prompt.js` — every curl-with-token block stripped (IMAGINE,
  REBUILD, REMIND, EVENT, EVENT_JOIN). Tag form is now the only
  documented capability surface.
- `user-profiles.js` — calendar fallback line in DM profile context
  no longer references curl.

**4 new tag handlers added** in bot.js to cover capabilities that
previously only had a curl form:
- `[REMIND: ...]` — reminder scheduling, sender-clobbered
- `[EVENT: ...]` — group event creation, sender + chat-id clobbered
- `[EVENT_JOIN: ...]` — RSVP, sender clobbered
- `[REBUILD]` — owner-only, DM-only

All 4 use the parse-then-clobber pattern.

**Verification:**
- `docker compose up -d --build` clean.
- Both startup probes log `[security] INTERNAL_API_TOKEN loaded via
  closure; process.env state: scrubbed` (server.js and bot.js).
- Smoke test: `[smoke-test] Results: 5 passed, 0 failed`.
- Direct child-env probe (mirrors `runner.js` spawn block exactly):
  `CLAUDE_ENV: UNSET` — Claude's child process cannot see the token.
- Closure path works: in-process `POST /weather` with closure token →
  `Status: 200`.
- Auth gate works: `POST /weather` with empty token → `Status: 401
  {"error":"unauthorized"}`.
- Signal webhook query-token still works → `Status: 200`.

**Caveat (not a bug):** `docker compose exec claude-api node -e
'console.log(process.env.INTERNAL_API_TOKEN || "UNSET")'` will print the
token because `docker exec` spawns a fresh process inheriting the
container env (which still has the var set by `docker-compose.yml`).
This does NOT reflect what Claude sees. Claude is spawned by `runner.js`
with an explicit env block that omits the token. The relevant test is
the child-env probe. To make `docker exec` itself show UNSET, the env
var would need to be removed from `docker-compose.yml` and injected
via secrets at startup — out of scope for this session.

### Theme 7 — New plugins, commands, and help additions

Earlier in the same session (before the privacy incident):

**New plugins** with deterministic server-side fetch:
- `plugins/weather/` — Open-Meteo geocode + 16-day forecast, no API key.
  Replaces brittle WebSearch scraping that returned monthly averages
  from content farms.
- `plugins/product-search/` — DDG HTML scrape + Amazon/Walmart/Target
  search URLs. Strong anti-refusal instructions. `!product` /
  `!search` / `!shop` / `!link` / `!buy` aliases.

**New endpoints** in `server.js`: `POST /calendar/events`, `POST
/weather`, `POST /products/search`. Each protected by the (now
closure-stored) internal token. Tag handlers in bot.js: `[CALENDAR:]`,
`[WEATHER:]`, `[PRODUCT:]`.

**New commands:**
- `!track list/add/remove/clear` — CLI-style editor for
  `profile.concert_tracker_artists` (so users don't have to re-run the
  full wizard for one tweak).
- `!product` — see plugins above.
- `!commands` — standalone command listing.

**`help.js`** — added Concerts and Shopping sections.

### Theme 8 — Wizard polish (concert-tracker wizard)

- `"remove everything EXCEPT for: ..."` now correctly KEEPS the listed
  items instead of removing them. (Karen hit this exact bug.)
- Pasted numbered list ≥3 lines = full replacement.
- Multi-tier price alerts: `"$50, $100, $200"` and natural language
  ("under $75") accepted.
- `onCancel` hook saves partial state on early exit so a wizard that
  the user abandons mid-flow still persists the trimmed artist list.
- `!command` mid-wizard silently cancels the wizard (running `onCancel`)
  and falls through to the command router, fixing the "stuck wizard
  eats every command" bug.
- Curated list persists to `profile.concert_tracker_artists`; next
  wizard run shows the curated list instead of re-pulling raw Spotify
  tags.
- `addSchedule()` positional-args bug fixed (previously every wizard-
  created schedule was orphaned with `userId=null` and never fired).
- Dedupe + immediate `registerJob` (already documented above in Theme 4).

### Theme 9 — Spotify import improvements

- `spotify-auth.js`: in-place tag upgrade — an existing `'Custom'` tag
  for the same artist (e.g. from a `!remember`) is promoted to
  `'Artist'` instead of being dropped by the label dedup. Single
  write at the end of import. `user-read-recently-played` scope added.
- Background-import after OAuth callback so the browser doesn't time
  out and consume the state token.
- Playlists source disabled (Spotify Extended Quota Mode 2024-11-27
  restriction; key retained for shape compatibility, always
  `{raw: 0, added: 0}`).
- `commands/refreshartists.js`: whoami + live top-5 diagnostic to
  distinguish "wrong account linked" from "Spotify just doesn't know
  your top".

### Theme 10 — Signal polish

- **Reaction context lift**: rolling window cache now stores `ts + text`,
  cap 30. Synthetic dispatched message includes the original bot
  message so 👍/👎 carry context instead of a naked yes/no.
- **Fail-closed reaction check**: no hit in cache → no dispatch. Fixes
  the post-restart bug where 👍 on other group members' messages
  triggered Bianca responses.
- **Group read receipts disabled** — was surfacing as "Bianca read your
  message" in the group UI.
- **Wizard escape hatch** as above.

### Bot-team agents installed

The custom team agents from `claude-api/project-template/.claude/agents/`
have been copied to `~/.claude/agents/` so they become available as
proper `subagent_type` values starting in the **next** Claude Code
session (not this one — the agent registry loads at session start):

- `principal-engineer`, `principal-product-manager`, `project-manager`
- `backend-lead-engineer`, `frontend-lead-engineer`, `ai-engineer`
- `senior-frontend-engineer`, `frontend-engineer`
- `qa-engineer`, `manual-qa-tester`, `data-scientist`, `lead-designer`

There is a memory note from Karen telling future Claude sessions to
**always pick the most specific specialist** when spawning agents —
never default to `general-purpose` when a specialist exists.

### Outstanding follow-ups (NOT done this session)

Each of these is real, scoped, and worth picking up next session.

1. **Wizard state is not persisted across bot restarts.** A rebuild
   mid-wizard silently loses `_artistList` from the in-memory wizard
   state. Users who started `!concerttracker` right before a deploy
   would hit the same symptom that triggered Theme 5 — except the
   paper-trail logging won't catch it because `onCancel` never fires
   (the wizard simply ceases to exist). Fix: serialize wizard state
   to `channel-persistence.js`, restore on startup. **Scope:**
   ~80 lines in `wizard.js` + `channel-persistence.js`.

2. **`!concerttracker` re-run while a prior wizard is alive overwrites
   `state.wizard`** without flushing. Same data-loss class as #1.
   Fix: at the top of the wizard start path, if `state.wizard` is
   non-null, call `cancelWizard(state, message, {silent: true})` first
   to flush `onCancel`. **Scope:** ~5 lines.

3. **Vector 8 Phase 2 — HMAC + nonce + replay protection** on the
   internal API. Phase 1 (Theme 6) is the actual fix for the immediate
   risk (Claude can't see the token any more). Phase 2 would add
   defense-in-depth against compromise of bot.js itself, and against
   the small race window where a fresh `docker exec` might still see
   the token. Design: HMAC-SHA256 over `method + path + body +
   timestamp` using a separate `INTERNAL_HMAC_KEY` env var, 5-minute
   timestamp window, in-memory LRU nonce cache. **Scope:** ~150 lines
   in `server.js` middleware + bot.js call sites + a small client
   helper. Not urgent, but the user explicitly said "I want to do
   this" — schedule it.

4. **`docker-compose.yml` env scrubbing.** To make the `docker exec`
   probe show `UNSET` (and to remove the brief startup window where
   the env var exists), move `INTERNAL_API_TOKEN` from compose env to
   a Docker secret or runtime injection that internal-token.js reads
   from a file path and then deletes the file. **Scope:** small but
   touches container ops.

5. **The two `.cloudflared` operator scripts** (`.fix-cloudflared.sh`
   and `.update-cloudflared-token.sh`) live in the project root and
   are now `.gitignore`d, but they should physically move to a
   separate `~/ops/` directory or similar. They contain a hardcoded
   tunnel UUID and a script that reads a real token from `/tmp/cf.tok`
   — operator-only emergency scripts that don't belong in the repo at
   all.

6. **Concert-tracker price scrapers (`concert-scraper` Docker service)
   were timing out on every request** during this session — see logs
   for `[ConcertScraper] searchPrices error (vividseats|tickpick|
   seatgeek|stubhub): aborted due to timeout`. The new deterministic
   scheduled-job path uses TM face-value prices only, so this isn't
   blocking concert tracking, but `!prices` and the concert-tracker's
   secondary-market alerting still depend on it. Worth investigating
   independently — could be a captcha, a network issue, or a deploy
   regression in the scraper container.

7. **Two paused-then-deleted Concert Price Tracker users** need to
   re-run `!concerttracker` to get back on the new deterministic
   payload format. They are: Karen (`+1631...87`) and the Boston user
   (`1d72e654-0247-4e8b-9656-042a28c77ea5`). Until they do, no
   concert tracking fires for them. The wizard now persists structured
   payloads so this is the last manual step.

### Determinism Rule status across the bot

Every previously-prompt-controlled privacy/identity boundary is now
enforced in code:

- ✅ Calendar — fail-closed server redaction + parse-then-clobber bot
- ✅ Notes (`[NOTE:]`, `[UPDATE_NOTES:]`) — hardcoded `msg.senderId`
- ✅ Flight registration — hardcoded sender
- ✅ Eight Sleep — hardcoded sender
- ✅ Reminders, events, event-joins, rebuild — new tag handlers, all
  parse-then-clobber
- ✅ Group member context — stripped helper (`buildGroupMemberContext`)
- ✅ Group **sender** context — stripped branch in `buildProfileContext`
- ✅ `[LEARNED:]` — PII filter + length cap
- ✅ Concert tracker scheduled jobs — Claude not in the loop at all
- ✅ Plugin outputs — sent directly via `signalAdapter.sendMessage`,
  not through Claude
- ✅ `INTERNAL_API_TOKEN` — closure-stored, scrubbed from
  `process.env`, never given to Claude

**If you removed every privacy-related sentence from every system prompt
and plugin instruction tomorrow, the security guarantees would still
hold.** That is the standard going forward.

---

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
