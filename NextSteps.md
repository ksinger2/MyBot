# MyBot — Next Steps

## What's Working
<!-- Updated each session — 2026-06-07 -->
- On-call watchdog (`oncall-watchdog.js`) running every 2min with 8 deterministic health checks:
  1. CLI auth health (escalates after 3 failures, 30min cooldown)
  2. Sandbox credential freshness (auto-refreshes if >5min stale)
  3. Process leak detection (kills orphan claude processes >10, escalates node >20)
  4. Disk space monitoring (/tmp sweep at 80%, escalate /app/data at 90%)
  5. Event loop lag (graceful restart after 3 consecutive >30s readings)
  6. Semaphore leak detection (clears stuck busy channels with dead processes)
  7. Tunnel health (auto-revives stopped Cloudflare tunnel when port mappings exist)
  8. Sandbox disk usage (alerts owner when any workspace >2GB)
- `/health/watchdog` endpoint returns rolling health report (last 10 cycles)
- `/health` endpoint now uses watchdog's cached CLI result (no redundant spawns)
- Sandbox auth hardening: 3-layer defense (per-spawn refresh + 60s periodic + auth-failure retry)
- All sandbox users (Merrisa, Daniel, Lee) have fresh creds and are ready
- **Cloudflare tokens shared globally**: Sandbox users now inherit global `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from process.env when no per-sandbox token is set (fixes group chat "no API key" errors)
- Missed-message recovery: on restart, detects webhook gaps >90s via persisted timestamp (`/app/data/watchdog-state.json`), proactively messages recently active chats to resend. Guards against null adapter, double-notify with auto-resume, and logs write failures.
- Owner DM now uses `claude-opus-4-6` (200k context) with high effort (was `claude-opus-4-7`)
- `!reinit` command and `/reinit` skill wired up (command-utils.js, reinit-prompt.js, commands/reinit.js)
- Queue runner now passes a proper ChannelProxy to `runClaudeWithContinuation` for progress messages
- `isCommandLike()` utility replaces raw `text.startsWith('!')` checks (supports `/` prefix too)
- Google auth token reconciliation now cross-references UUID↔phone map for accurate token lookup
- Concert price scraper now deterministic: `auto-context.js` detects ticket/price intent, extracts artist names, pre-fetches from scraper, injects `<concert-price-data>` into prompt — no tag emission needed from Claude
- **OAuth token auto-refresh**: `token-refresh.js` does direct OAuth2 refresh via `https://platform.claude.com/v1/oauth/token` — no CLI spawn needed. Syncs from Windows credentials mount as first try, falls back to direct HTTP refresh. Token refreshes every 10min when <2hr remaining. Detects `invalid_grant`/401 (revoked tokens) and suppresses retries for 30min. Deep-merges creds to preserve unknown fields. Uses `??` for refresh_token preservation (not `||`).
- **All calendar events via bot account**: Every event mutation (create, patch) goes through `getBotCalendarClient()` (`bianca.she.da.cow@gmail.com`). Verified across all 11 mutation paths: calendar-cli.js, /remind, /event, /event/join, calendar-coordinator, and all 6 tag handlers. `getCalendarClient(userId)` only used for READ (list events, freebusy). All null-check paths fail hard with zero fallback to personal calendars.
- **All email drafts via bot account**: `email-search-cli.js draft` and `/email/draft` endpoint both use `getBotGmailClient()`. Search/thread reads correctly use owner's inbox.
- **EVENT_INTENT detection**: `auto-context.js` detects "schedule/create/add an event" and injects a system hint telling Claude to emit an `[EVENT:]` tag — prevents the 22-turn code investigation spirals.
- **Queue path runs tag handlers**: `processQueue` now calls `enrichWithContext()` before Claude (injects REMIND/EVENT hints for queued messages) and runs REMIND/EVENT tag handlers on the result. Previously, queued messages silently dropped all tags.
- **Deterministic datetime parsing**: `_resolveRemindDatetime()` parses "tomorrow at 2pm" server-side into an ISO string with correct timezone offset. Defaults to 10am when no time specified. Injected into prompt so Claude just fills in the title.
- **Multi-user reminders**: `_resolveRemindAttendees()` matches names in message against group member profiles (word-boundary matching). All matched users passed as `attendee_ids` to `/remind`, which creates one event with all attendees.
- **Signal user token cross-referencing**: `getTokenForSignalUser()` in `user-tokens.js` tries phone→UUID and UUID→phone via the UUID map, fixing Merrisa's calendar connection and all Signal user Google integrations
- **`/calendar/freebusy` endpoint**: New internal API for checking multi-user availability in one call
- **`!plan` command enhanced**: Accepts event poster images or text, runs 7-step research pipeline (venue, seating, interior photo, ticket prices via concert scraper, calendar check for all group members, parking/transport), stores result server-side for deterministic follow-ups
- **WSL stability**: `.wslconfig` has `autoMemoryReclaim=gradual`, WSL vhdx compacted (141GB→56GB), Windows credentials mounted read-only into container
- **Signal admin role**: `isSignalAdmin()` in `project-permissions.js` — trusted users bypass group mention filters, get owner-like turn caps (75), no tool restrictions in DMs
- **Progress circuit breaker with agent awareness**: 3 auto-kill triggers with dynamic thresholds. Default: 15 silent turns / 15min no output / 10min stale. Sandbox sessions: turn-count breaker disabled (coding needs unlimited tool calls), time-based only (25min no output / 15min stale). Post-answer agents (answered user >200 chars, then spawned agent): 8 turns / 5min / 5min. Fail-fast (3+ agent errors or spawn cap exceeded): 3 turns / 2min / 2min. Short progress messages (<200 chars) no longer trigger post-answer mode.
- **Group stall detector**: Separate thresholds (2min thinking, 5min bash), friendly "try again" message instead of diagnostic dumps. `currentTool` now correctly tracks active tool (was always null due to premature clear).
- **Group chat link detection**: Messages with URLs now trigger bot response in listenToAll mode even without question marks or task keywords — fixes TikTok/Instagram link sharing being ignored
- **Signal link formatting**: URLs no longer stripped from markdown links — always preserved as clickable text
- **Owner DM safety caps**: 60min hard timeout (was unlimited), 200 max turns (was 1000)
- **Image delivery 3-source union**: Image registry + extractImageAttachments on result.text + strippedImagePaths from streaming proxy. Streaming proxy also strips `/workspace/` paths and `.gif` files. All paths validated with `path.resolve()` + directory prefix check.
- **Message grouping dedup**: Duplicate webhook deliveries (same timestamp + content) are now dropped before entering the grouping buffer — prevents doubled URLs/content.
- **Sandbox UID resolution**: `_getUid()` no longer caches null results. Runner retries provisioning at spawn time if UID is missing, and rejects with a clear error instead of silently falling through to non-sandbox mode.
- **E2E test harness** (`tests/e2e-signal-test.js`): 8-test suite validates full Signal webhook pipeline — owner DM greetings, Claude CLI queries, group ignore (listenToAll OFF), !status, sandbox user routing, auth rejection, @mention response, !listen toggle. Run with `node tests/e2e-signal-test.js`.
- **Signal watchdog enhanced**: Detects dead WebSocket (HTTP healthy but no webhook envelopes in 60min), restarts signal-api container. Uses webhook envelope activity (receipts, read notifications — always flowing) instead of text messages (30min gaps normal). Restart notifications silenced — not user-actionable. Check `!health` or docker logs instead.
- **Remote auth (!login)**: Owner can re-authenticate Claude CLI from phone via Signal DM.
- **Agent guardrails (system prompt)**: Both owner DM and non-owner prompts now explicitly bar self-initiated agent spawning: "ONLY for user-requested multi-step engineering tasks. NEVER for self-initiated investigation, follow-up diagnostics, or curiosity."
- **Agent fail-fast**: Each sub-agent tracks `consecutiveErrors`. On 3+ consecutive tool errors, `_agentFailFast` flag triggers 2-minute kill thresholds. Post-answer agent spawn cap: 3rd+ agent after answer delivered triggers immediate fail-fast.
- **Oncall watchdog dedup**: All escalations now route through `sendErrorAlert` for 15-min dedup. Previously, `escalate()` sent direct Signal DMs bypassing dedup — process leak and disk alerts could spam every 2 minutes.
- **Token refresh efficiency**: Tiered approach — (1) sync Windows credentials (free), (2) direct OAuth2 POST to `platform.claude.com/v1/oauth/token` with refresh_token (<1s, no CLI spawn). Runs every 10min when token < 2hr remaining. Queue and direct paths both retry once on auth failure before alerting owner.
- **Claude CLI pinned**: `CLAUDE_CODE_VERSION: "2.1.143"` in docker-compose.yml (was "latest" — any rebuild could pull breaking changes).
- **Command context continuity**: Commands (`!product`, `!help`, etc.) now record both the user's command and the bot's reply in `recentMessages`. Follow-up questions ("how much are those?") have full context about what the command found. Implemented via reply/send proxy wrapper in bot.js.
- **Product query cleaning**: `cleanProductQuery()` strips conversational filler from natural language product requests, extracts store preference (Amazon/Walmart/Target), and preserves brand names. "add a nice and good deal product to my amazon cart that is a planter, 8 ft long" → query: "planter 8 ft long", store: amazon.
- **Cart approval fast-path (deterministic)**: "1", "add 1", "add all" now processed directly via `approvalGate` without spawning Claude — same pattern as the greeting fast-path. 👍 reactions on cart prompts (identified by 🛒 prefix, which is infrastructure-generated) also auto-approve directly. Pending items cleared after processing to prevent duplicate execution. Previously, both paths spawned a full Claude CLI session that had to figure out it should emit `[CART_ADD: action="add" ids="1"]` — which stalled at turn 0 twice in a row.
- **Content-based message dedup**: New early dedup layer catches Signal re-deliveries with different timestamps but identical normalized content (e.g. with/without U+FFFC prefix). Keyed on `chatId:senderId:normalizedContent` with 2s window. Runs before command handler — fixes duplicate `!listen on` responses.
- **Parallel link enrichment**: Link metadata, TikTok transcripts, Instagram transcripts, and auto-context now fetch in parallel via `Promise.all`. Response time for link messages drops from ~25s (sequential) to ~10s (max of individual fetches).
- **Sandbox group chat parity**: Sandbox users' group chats now behave like owner DM engineering sessions:
  - Auto-respond to all messages (bypass listenToAll, mention filter, and conversational filter)
  - Use Opus model (was Sonnet — can't code with Sonnet)
  - 30-turn limit (was 8 for regular groups)
  - System prompt says "SANDBOX GROUP: Full engineering access" (was "No file ops, no Bash")
  - Agents allowed for coding tasks (were suppressed in groups)
  - Normal stall thresholds (5min thinking, 10min bash) instead of aggressive group thresholds (2min/5min)
  - Normal 5min check-in interval instead of 90s group interval
  - Ghost-reaper treats sandbox as owner-level (75min limit, was 15min non-owner limit — this was killing active coding sessions)
  - Circuit breaker turn-count disabled (time-based only — coding routinely does 50+ tool calls without text output)
  - Session IDs preserved through rebuilds (was wiping all sessions on every rebuild)
  - Detection works by sender ID (sandbox user in any group) OR chat link (via `!sandbox link`)

## Recently Fixed (2026-05-24)
- **`!listen off` actually sticks now — 3 root causes** (the user-facing complaint: "bot turns listen on every rebuild on all channels despite explicitly being turned off in some channels"):
  1. **Sandbox-user bypass too broad** (bot.js:1880, now `getSandboxForChat` only): Detection used `getSandboxForChat(chatId) || getSandboxUser(senderId)`. The senderId clause meant Daniel/Lee/Merrisa speaking in ANY casual group (family chat, etc.) was treated as a sandbox engineering session, bypassing `!listen off` entirely. Now only chats explicitly linked via `!sandbox link` get the bypass; casual chats obey listen state regardless of who's talking.
  2. **Admin (Merrisa) bypass on listen filter** (bot.js:1893): `SIGNAL_ADMIN_NUMBERS` members skipped the listen check unconditionally. Removed — admins still get owner-like access (no tool restrictions, higher turn caps) once a message is processed, but they no longer auto-trigger the bot in listen-off groups.
  3. **Duplicate channel-state keys** (bot.js:2569 + channel-persistence.js): Different code paths in `_dispatchSignalMessage` saved state under `signal:<id>` (correct) vs raw `<id>` (resumeChannel, reaction handler, rebuild-resume). The same chat ended up with two entries on disk, with `!listen on` only sticking on whichever path ran last. Normalized via `const channelId = chatId.startsWith('signal:') ? chatId : \`signal:${chatId}\`` at function entry; added one-shot migration in `loadAllChannelStates` to merge any existing duplicates on load.
- **Auto-retry transient runner failures + preserve activeTask through errors** (bot.js:`_isTransientRunnerError`, direct path & queue path): Previously a spawn-time EACCES/ENOENT or stall-killed dead process surfaced to the user as "Sorry, something went wrong" with no retry. Auth failures had retry; nothing else did. Now: transient errors (EACCES, ENOENT, EPERM, ECONNRESET, ETIMEDOUT, EAGAIN, EPIPE, `spawn X` failures, "process died with no output") get one auto-retry with 2s backoff before showing the user-facing error. Hard timeouts, progress circuit breakers, and turn-limit exhaustion are deliberate kills and intentionally still fall through (retrying them just wastes turns). Separately: `activeTask` is now preserved on fatal errors (was unconditionally cleared in finally) so the cross-rebuild auto-resume path picks them up on next start. 1hr stale-TTL in channel-persistence guards against forever-loops.
- **Real Google Chrome installed in container** (Dockerfile): Both `@playwright/mcp` (default `--browser chrome`) and `chrome-devtools-mcp` look for `/opt/google/chrome/chrome` and silently error if it's missing. The container only had Chromium (from Playwright's `install chromium`). Every TikTok navigate failed with "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome" or "Could not find Google Chrome executable for channel 'stable'" — this was the visible "no Chrome available" loop where Bianca tried 9+ approaches and gave up. Dockerfile now runs `playwright install chrome` alongside chromium. Chromium stays for amazon-cart.js (uses Playwright Node API directly).
- **Tests: hardcoded host paths broke container build** (tests/runner-audit.test.js): Used `/mnt/c/Users/karen/.../claude-api/` absolute paths to require stubbed modules. Container has files at `/app/`, so the build's `node --test tests/*.test.js` step failed and aborted every Docker rebuild. Switched to `path.resolve(__dirname, '..')`. Build is green again.

## Recently Fixed (2026-05-22)
- **Auth token refresh actually works now**: `_proactiveRefresh()` was using `claude --version` (Step 2) which exits before initializing the OAuth layer — tokens were never actually refreshed. Replaced with `claude -p "ok" --max-turns 1` which forces the SDK through the full auth exchange. Removed the redundant Step 3 that only ran in critical zone (<30min) — now the single prompt step runs whenever token < 2hr.
- **Queue path auth retry**: Queue processing had NO retry on auth failure (instant fail + misleading message). Now mirrors the direct message path: refreshes sandbox creds + Windows sync → retries spawn once → only fails if retry also fails.
- **Auth error messages fixed**: "I'm taking a quick break — try again in a few minutes!" replaced with context-aware messages. Owner sees "Auth expired — send !login to re-authenticate." Non-owners see "Sorry, I'm having a temporary issue. The owner has been notified."
- **Auth alerts consolidated**: Three separate error sources (`token-refresh`, `auth-signal`, `auth-queue`) all used different dedup keys, so the owner got 2-3 alerts for one root cause. All unified to `source: 'auth'` — owner gets exactly one alert per 15-min window, now with `[channelId]` context showing which chat triggered it.
- **Notification suppression gap closed**: `notifyOwnerAuthExpiring()` suppressed alerts when token > 10min remaining, but the 15-min heartbeat could miss the window entirely (11min at check → suppressed → next check at -4min → expired without warning). Removed the inner suppression — already guarded by 1-hour dedup and the `<= EXPIRY_WARN_MINUTES` caller check.
- **Queue double-send fix**: `sendLongMessage` in queue path wasn't guarded by `result.streamed` — successful streamed responses were sent twice (once via streaming, once via `sendLongMessage`). Now matches the direct path pattern: `if (!result.streamed && result.text)`.
- **`!listen` now admin-only**: Was `adminOnly: false` — any group member could accidentally toggle the bot to respond to everything. Now only the owner can change listening state.
- **Corrupt Windows creds overwrote valid token** (token-refresh.js:36): Empty `catch {}` in `syncWindowsCredentials` swallowed JSON parse errors on corrupt Windows credential files, fell through to `writeFileSync` and replaced valid OAuth token with garbage. Fixed with `catch { return false; }`.
- **Token refresh concurrent tick race** (token-refresh.js:174): `refreshToken()` had no mutex — overlapping 15-min interval ticks could race on `syncWindowsCredentials` file rename. Added `_refreshInProgress` flag with try/finally.
- **Sandbox privilege escalation** (sandbox.js:46): `_linuxUserName("!!!")` returned `"sandbox-"` — all-symbol display names collapsed to the same Linux user, sharing workspace and credentials. Now throws if sanitized name is empty.
- **messageDelete concurrent dispatch race** (bot.js:2366): `messageDelete` handler set `state.busy = false` immediately on delete, before `_dispatchSignalMessage`'s `finally` block ran. New messages could enter during the gap, spawning concurrent CLI processes. Removed — SIGTERM unwinds through runner → finally block handles cleanup.
- **Semaphore eviction slot loss** (runner.js:125): Owner waiter was pushed to `_ownerQueue` AFTER `forceKillProcess`. If the evicted process died instantly, the close handler released the slot before the owner was queued — slot permanently lost. Reordered: push before kill.
- **Hard timeout interval leak** (runner.js:1090): Hard timeout handler didn't clear `stallCheck`/`checkinTimer` intervals before rejecting. Check-in timer continued sending messages to Discord on a dead session. Added `clearInterval` calls before `wrappedReject`.
- **Auth notification spam loop** (token-refresh.js:113): `_ownerNotifiedAt` was set AFTER `sendErrorAlert`, inside try/catch with empty catch. If send failed, timestamp was never set → every 15-min tick retried → permanent spam. Moved timestamp before send.
- **Auth failure detection gap** (runner.js:822): "Not logged in" in result text was only caught when `event.is_error` was true. CLI could return auth failures with `is_error: false`, silently falling through. Removed the `is_error` gate.
- **Rate limit flag dropped on partial results** (runner.js:1366): When CLI hit rate limit mid-stream with partial output, `rateLimited` flag wasn't propagated — caller couldn't retry. Added `rateLimited: hitRateLimit || false` to the resolve path.
- **Queue turn-limit silence** (bot.js:1527): Queue path had no feedback when turn limit was hit with no streamed/text output — user got complete silence. Added `hitTurnLimit` branch matching the direct path.
- **Auth retry stale sessionId** (bot.js:1475, 2985): Both auth retry paths reused the original `sessionId` from the failed attempt. Cleared `opts.sessionId = null` before retry in both queue and direct paths.
- **Alert dedup bypass** (error-alerting.js:30): Cleanup eviction threshold was 10 min but dedup window was 15 min. Entries aged 11-14 min were evicted then immediately re-alerted. Aligned to 15 min.

## Recently Fixed (2026-05-21)
- **Sandbox `sandboxUser is not defined` crash**: `runner.js` referenced `sandboxUser` as a bare variable instead of `this.sandboxUser` in 3 places (system prompt builder, stall detector, check-in interval). Every sandbox session crashed immediately with "Sorry, something went wrong." Fixed by using `this.sandboxUser` consistently.
- **Ghost-reaper killing sandbox sessions at 15min**: Sandbox processes were registered as non-owner (`isOwner: false`), so the ghost-reaper killed them after `MAX_NON_OWNER_AGE_MS` (15min). Daniel's 67-turn site deployment was killed at 16min. Fixed by setting `this.isOwner = true` for sandbox sessions, giving them the 75min owner limit.
- **Circuit breaker killing sandbox at 15/25 turns**: Turn-count breaker fired on legitimate engineering work (write files, run builds, deploy). Disabled turn-count trigger entirely for sandbox sessions — only time-based checks remain (25min silent, 15min stale).
- **Post-answer agent detection too aggressive**: Any streamed text (even "Let me look...") set `streamedAny=true`, causing subsequent Agent spawns to trigger the tight 8-turn threshold. Now requires >200 chars of streamed text before counting as a "substantive answer." Tracked via `streamedChars` counter in progress state.
- **Sandbox groups ignored messages**: Three independent filters blocked sandbox group messages: (1) `listenToAll` OFF by default, (2) "addressing another person" heuristic, (3) "short conversational" heuristic. All three now bypassed when sender is a sandbox user or chat is sandbox-linked.
- **Sandbox groups used Sonnet with 8-turn limit**: Both main dispatch and queue handler hardcoded Sonnet for all groups. Now sandbox groups use Opus with 30-turn limit. System prompt switched from "GROUPS: No file ops, no Bash" to "SANDBOX GROUP: Full engineering access."
- **Rebuild wiped all session IDs**: `_startupMarkers.wasRebuild` cleared every channel's `sessionId` to prevent rebuild loops. Now only clears owner/social sessions — sandbox sessions are preserved so coding work resumes seamlessly.

## Previously Fixed (2026-05-20)
- **Chrome MCP tools in group chat whitelist**: `nonOwnerToolWhitelist` now includes `ToolSearch` + 5 Chrome MCP tools (`navigate_page`, `take_snapshot`, `take_screenshot`, `close_page`, `list_pages`). When WebFetch is blocked by a site, the bot can now fall back to Chrome browser automation instead of trying 10+ workaround approaches over 11 minutes. Fixed in both the main dispatch path (bot.js:2771) and queue handler (bot.js:1430).
- **Sandbox tools include Chrome MCP**: `DEFAULT_TOOLS` in sandbox.js now includes Chrome MCP tools. Existing sandbox users (Daniel, Lee, Merrisa) auto-migrated on startup via `provisionAll()`. Sandbox-linked group chats in the queue handler now resolve sandbox config (tools, cwd) correctly — previously always used the flat nonOwnerToolWhitelist.
- **Group chat speed — 3 fixes**:
  1. Max turns cut from 20 → 8 for non-sandbox group chats (sandbox groups keep 20 for coding tasks). Stops the bot from doing 15 rounds of "let me try another approach" for a simple web lookup.
  2. SPEED rule added to group system prompt: "1-2 tool calls max for lookups, give the answer you have, use Chrome MCP if WebFetch fails."
  3. Check-in interval cut from 5min → 90s for groups. Owner DMs keep 5min.
- **Stall detector included sandbox group users**: `_isGroupStall` at runner.js:1174 had `&& !this.sandboxUser`, so sandbox users in groups got raw diagnostic dumps instead of friendly "try again" messages. Fixed by removing the sandbox exclusion.
- **Rate limit → 0-turn stall kill**: API rate limits at session startup caused the stall detector to kill sessions before they started. Fixed by resetting stall timers on `rate_limit_event` and extending threshold to 10min when rate-limited.
- **Auth error text streamed to groups**: `"Failed to authenticate. API Error: 401..."` was streamed as regular text before the auth handler could suppress it. Fixed by guarding the streaming path with `!hitAuthFailure`.
- **Session ID mismatch on retry**: After a 0-turn stall kill, the stale session ID was reused → "No conversation found". Fixed by clearing `sessionId` when `turnCount === 0`.
- **Playwright URL blocking completely broken**: `playwright-wrapper.js` intercepted stdout (responses FROM Playwright) looking for `tools/call` request patterns — never matched. Complete rewrite to intercept stdin (requests TO Playwright) and properly block `playwright_navigate` to checkout URLs and `playwright_evaluate_script` containing checkout URLs.
- **Sandbox cross-read prevention**: `/sandbox` parent changed from 755 to 711 (traverse only, no listing). Each sandbox dir set to 700. `/host` hidden inside sandbox mount namespace via tmpfs overlay.
- **GH_TOKEN stripped from sandbox env**: Sandbox processes no longer inherit the owner's GitHub token.
- **Token credential write atomicity**: `token-refresh.js` now writes to `.tmp.${process.pid}` then `fs.renameSync` instead of direct `writeFileSync` — prevents half-written credentials on crash.
- **XSS in setup page**: `server.js` CSRF token injection changed from `escapeHtml()` (insufficient for JS context) to `JSON.stringify()`.
- **Sandbox provisionAll error**: `_groupLinks` internal entry was iterated as a sandbox user, causing "Failed to provision undefined" error. Fixed by filtering entries to those with `linuxUser` property.
- **Sandbox spawn EACCES**: `sandboxUser` was never passed through `askClaude()` to the Runner — the destructured parameter list was missing it, so sandbox sessions spawned `claude` directly (not via `sudo/unshare/runuser`), hitting EACCES on the 700 sandbox dir. Fixed by adding `sandboxUser` to `askClaude()` parameter list. Also fixed the spawn cwd: sandbox dirs are 700 so Node's pre-exec chdir fails — now spawns with `cwd: '/tmp'` and `cd`s into the sandbox dir inside the unshare command where root can traverse it.

## Recently Fixed (2026-06-01 → 2026-06-07)

### Queue Path Tag Handlers (2026-06-07)
- **Critical bug**: `processQueue` never ran `enrichWithContext` (no system hints for queued messages) and never ran tag handlers (REMIND/EVENT tags silently swallowed). Any reminder or event request that arrived while the bot was busy processing another message would appear to work but create nothing.
- **Fix**: `enrichWithContext()` now runs before Claude in the queue path, and REMIND/EVENT tag handlers run on queued results — matching the direct dispatch path.

### Bot Calendar Enforcement (2026-06-06)
- **calendar-cli.js create**: Was using `getCalendarClient(SIGNAL_OWNER)` — events went on owner's personal Google Calendar. Now uses `getBotCalendarClient()` exclusively with `sendUpdates: 'all'` for invite emails.
- **email-search-cli.js draft**: Was using `getGmailClient(SIGNAL_OWNER)` — drafts went to owner's personal Gmail. Now uses `getBotGmailClient()`. Search/thread reads remain on owner's inbox.
- **EVENT_INTENT detection**: Added `EVENT_INTENT` regex in `auto-context.js` — "schedule/create an event" now triggers a system hint. Previously, only REMIND intent existed, so event requests went into 22-turn code investigation spirals.
- **Anti-investigation guardrails**: Both REMIND and EVENT system hints now say "Do NOT use Bash, Read, Grep, or any tools — just emit the tag directly. This is a 1-turn task."

### 10 Reliability Fixes from Agent Review (2026-06-02)
- `channelState` → `state` in REMIND tag handler (was undefined — group attendees silently failed)
- `||` → `??` for refresh_token preservation (empty string would kill auth permanently)
- Deep-merge creds instead of rebuilding from scratch (preserves unknown fields)
- Detect `invalid_grant`/401 — stop retrying for 30min, alert owner immediately
- `_fmt()` uses local date fields not `toISOString()` (avoids UTC date-shift in Docker)
- Word-boundary name matching for attendees (prevents "Al" matching "all")
- Rate-limit only resets `lastActivity`, not output counters (prevents masking stuck sessions)
- Attachment check moved before prompt guard (attachment-only messages now get "resend file" message)
- Credential copy catch blocks log warnings instead of swallowing silently
- `attendee_ids` type validation + `_resolveRemindAttendees` error logging

### Deterministic Reminders (timezone + multi-user)
- **Wrong timezone**: `auto-context.js` defaulted to `America/New_York` when user had no profile timezone. System prompt said `America/Los_Angeles`. Claude saw conflicting hints and picked Eastern. Fixed: both defaults now `America/Los_Angeles`. More importantly, datetime is now **parsed server-side** — `_resolveRemindDatetime()` extracts "tomorrow at 2pm" into a resolved ISO string with correct timezone offset, injected into the prompt so Claude just fills in the title.
- **Single-user only**: REMIND tag handler clobbered `user_id` to `msg.senderId`, ignoring "for both me and Karen". Fixed: `_resolveRemindAttendees()` matches mentioned names against group member profiles, passes all matched IDs as `attendee_ids` to `/remind`. The endpoint now creates one calendar event with all matched users as attendees (Google sends invite emails to each).
- **No attendee resolution**: `/remind` only looked up the sender's email. If lookup failed silently, the event had 0 attendees. Now logs a warning per unresolved user and reports `attendees_resolved/attendees_requested` in the response.

### Direct OAuth Token Refresh (replaces fragile CLI spawn)
- **Root cause**: Token refresh depended on spawning `claude -p "ok"` to force the SDK through OAuth exchange. This was unreliable — the CLI could fail to start (EACCES, missing deps, rate limits), the SDK only refreshed near expiry (not proactively), and a 45s timeout locked out retries for 5 minutes.
- **Fix**: Direct HTTP POST to `https://platform.claude.com/v1/oauth/token` with the refresh_token. No CLI spawn, no SDK dependency, no DPoP. Extracted the production client_id (`9d1c250a-...`) and scopes from the CLI binary.
- **Result**: Token refresh is now deterministic — a single HTTP call that takes <1s, works at any token age, and writes fresh credentials atomically. The bot should never lose auth between `!login` sessions again.
- Removed: `AGGRESSIVE_REFRESH_MINUTES` near-expiry retry (no longer needed — direct refresh always works), `execFileAsync` import (CLI prompt no longer spawned for refresh).

### Auto-Resume Attachment Loop Fix
- **Root cause**: `activeTask.prompt` stored the file-augmented text (with `/tmp/signal-attachments/...` paths) truncated to 500 chars. After rebuild, files are gone and paths may be cut mid-way (e.g. `/tmp/signa`). `resumeChannel()` replayed the broken prompt verbatim with `attachments: []`, so Claude looped trying to read non-existent files until the circuit breaker killed it at 28 silent turns.
- **Fix 1** (bot.js:2646-2649): `_dispatchSignalMessage` now derives `_hadAttachments` and `_cleanPrompt` from `text` by detecting the `[The user attached` block. Strips ephemeral file paths from `activeTask.prompt`. Handles both inline (`\n\n[The user attached`) and start-of-text (attachment-only messages) cases.
- **Fix 2** (bot.js:2652): `activeTask` now includes `hadAttachments` flag, persisted to disk.
- **Fix 3** (bot.js:1332): `resumeChannel()` skips auto-resume when `task.hadAttachments` is true OR when the prompt contains `[The user attached` (catches stale persisted state from before this fix). User gets: "I restarted while working on your file — the attachment was lost. Please resend it."

### Circuit Breaker Hardening
- **Rate limit turn reset** (runner.js:816): `lastOutputTurn` now reset to current `turnCount` on `rate_limit_event`. Previously only `lastOutputTime` was reset — turn-based breaker could fire during rate-limited waits.
- **Sub-agent text counts as output** (runner.js:1027-1031): Sub-agent text blocks now update `lastOutputTurn`, `lastOutputTime`, and `lastActivity` on the parent session. Previously, sub-agent text was routed to `subagentText` bucket without updating progress counters, so sessions with active sub-agents appeared "silent" to the circuit breaker.

### Bot Calendar Account (bianca.she.da.cow@gmail.com)
- **Centralized event scheduling**: Bot now has its own Google account connected via `!botcalendar connect`. All events (`/event`, `/remind`, `/event/join`, `createGroupEvent`) are created on the bot's calendar with users added as attendees via `sendUpdates: 'all'`. No more per-user calendar creation — one event, Google sends invite emails.
- **Email drafts from bot account**: `/email/draft` defaults to bot's Gmail (`bianca.she.da.cow@gmail.com`). Pass `userId` explicitly to send from the owner's account instead (e.g. in owner DM).
- **`!botcalendar` command** (owner-only): `connect` / `disconnect` / `status` to manage the bot's Google account.
- **google-auth.js**: Added `BOT_CALENDAR_KEY`, `getBotCalendarClient()`, `getBotGmailClient()`, `getBotCalendarEmail()`.

### Permissions & Access
- **`!listen` open to all users**: Was `adminOnly: true` — non-owners couldn't toggle listen mode in groups. Now anyone can `!listen on/off`.
- **`!login` redirects non-owners**: Non-owners who run `!login` get a friendly redirect to `!setup` or `!connect`. CLI re-auth still owner-only.
- **Non-owner Bash access**: Added `Bash` to non-owner tool whitelist (both queue and direct paths). Non-owners can now ask the bot to create calendar events, set reminders, draft emails — all via internal API curl calls.

### Listen Filter Removed
- **listenToAll = respond to everything**: Removed the "short conversational message" heuristic that filtered non-question, non-task messages in `!listen on` groups. If listen mode is on, the bot responds to every message — owner's intent is explicit.

### Token & Auth Fixes
- **Merrisa's email resolved**: Token was stored under UUID only (`59237aa4-...`), not phone (`+16318487903`). Saved under both keys so lookups always find `merrisang13@gmail.com`.

## Recently Fixed (2026-05-30)

### WSL 24/7 Uptime Hardening (Phase 2 — Root Cause Fix)
- **Root cause identified**: C: drive at 0 GB free (931 GB total) caused all WSL failures. WSL enters "Running but wedged" states when disk is full — reports Running but commands fail with `getpwnam failed`, `CreateInstance/E_FAIL`, path translation errors. Existing watchdog detected failures but recovery also failed when disk was full, creating infinite fail loops.
- **WSL VHDX moved to D: drive** (226 GB freed): Exported via `wsl --export --vhd`, re-imported at `D:\WSL\Ubuntu\`. D: is a 14.9TB external USB HDD with 14.5TB free. Old VHDX on C: deleted. Default user (`karen`) preserved via `/etc/wsl.conf`.
- **Disk space monitoring added** (`scripts/disk-space-monitor.ps1`): Tiered auto-cleanup — warning at <20GB, standard cleanup at <10GB (temp files, orphaned swap VHDXs, Docker build cache, npm/pip cache), aggressive cleanup at <5GB (old node_modules, build dirs, old Downloads). Runs every 5min via Task Scheduler.
- **wsl-autostart.bat hardened**: Disk pre-check (if C: <2GB, run cleanup before recovery, FATAL if still full instead of infinite loop). D: drive presence check (VHDX on USB — attempts USB re-enumeration if missing). Wedged state detection (if `wsl -l -v` says Running but `echo alive` fails, forces `wsl --shutdown`). Log rotation (500 lines). Blockbuster PM2 health check (verifies PM2 daemon alive, cloudflare-tunnel online, starts from ecosystem config if needed).
- **mybot-heartbeat.ps1 hardened**: D: drive presence check before health check (skips recovery if VHDX drive missing). C: free space check every 30s with warning/emergency thresholds.
- **watchdog.sh hardened**: Docker disk usage monitoring (`docker system df`). WSL root filesystem check (auto-prune at >80%). C: drive free space check from WSL side. Dangling image prune on every run.
- **USB power management**: Disabled USB selective suspend and hard disk sleep timeout to prevent D: drive from sleeping/disconnecting.
- **Downloads cleaned**: ~58 GB of media moved to `D:\downloads-archive\`. Temp files and orphaned swap VHDXs cleaned.

### WSL 24/7 Uptime Hardening (Phase 1 — Original)
- **WSL watchdog rewritten** (`wsl-autostart.bat`): Now runs `wsl --shutdown` when Docker is wedged in HCS_E_CONNECTION_TIMEOUT, escalates to restarting HcsService + LxssManager as last resort. Previously just retried the same broken state for hours.
- **watchdog.sh**: Added Docker socket pre-check (10s timeout). Exit code 2 signals the .bat to force WSL shutdown instead of retrying.
- **Poll interval reduced** (`fix-autostart-task.ps1`): 5min → 1min. Task Scheduler `Duration = "P9999D"` added to ensure indefinite repetition.
- **New heartbeat** (`scripts/mybot-heartbeat.ps1`): 30s health checks, immediate HCS_E_CONNECTION_TIMEOUT detection, async stderr reading (fixes .NET pipe-buffer deadlock), 3-failure threshold → shutdown + recovery.
- **`.wslconfig`**: Memory 16GB → 12GB, `autoMemoryReclaim=gradual`, `sparseVhd=true`, `vmIdleTimeout=-1`.

### Cloudflare Tunnel 24/7 Uptime Hardening
- **Blockbuster PM2 boot persistence fixed**: PM2 systemd service (`pm2-karen.service`) updated with `ExecStartPre=/usr/local/bin/wait-for-mnt-c.sh` — waits up to 60s for `/mnt/c` mount before resurrecting services. Previously, PM2 resurrect ran before Windows filesystem was available, silently failing to start all Blockbuster services on WSL reboot.
- **Blockbuster monitoring added to watchdog** (`wsl-autostart.bat`): Every 1-min poll now checks PM2 daemon (`pm2 ping`), verifies `cloudflare-tunnel` is online, starts from ecosystem config if PM2 is down. Previously, only the MyBot Docker container was monitored — Blockbuster could be completely down with no detection.
- **MyBot tunnel permanent death removed** (`sandbox-tunnel.js`): Removed `MAX_RESTART_ATTEMPTS = 10` limit. Tunnel now retries forever with exponential backoff (5s→5min cap), reset after 30min stability. Previously, 10 consecutive crashes permanently killed the tunnel with no recovery.
- **Watchdog tunnel revival unconditional** (`oncall-watchdog.js`): Tunnel is now revived regardless of active port mappings. Previously required `mappings.length > 0`, so a tunnel that died with no active users stayed dead until someone registered a port.
- **Tunnel health check errors exposed** (`oncall-watchdog.js`): Tunnel module load errors now report `ok: false` instead of silently returning `ok: true`. Previously, a broken tunnel module was invisible to the watchdog.

### Agent Orchestration & Token Optimization
- **`!mode review`**: Third mode — read access + Bash (for tests/lint), no Edit/Write. System prompt: "REVIEW MODE: Audit, run tests, report issues. Do NOT make edits."
- **TOKEN BUDGET rules**: Explicit depth tiers in system prompt — 0 tools for chat, 1-2 for lookups, 3-5 for research, deep for engineering. "NEVER retry >2x", "STOP after answering".
- **Effort scaling**: `--effort medium` for first messages, `high` for continuing sessions and sandbox engineering. Saves tokens on simple questions.
- **`!orchestrate` command**: Multi-agent workflows — `!orchestrate engineering-task <desc>` or `!orchestrate self-improvement`. Templates with structured phases (Analyze → Implement → Review → QA Gate).
- **Self-review system** (`self-review.js`): Adversarial review prompts + read-only QA gate via separate Claude invocation (sonnet, cheap). QA:FAIL checked before QA:PASS.
- **`!autonomous` command**: Self-improvement mode — 30min heartbeat, reads NextSteps.md, fixes top-priority item, max 20 iterations/day, concurrency guard, busy-channel check, never auto-rebuilds.

### QA & Pre-Rebuild Gate
- **`POST /test` endpoint** (`server.js`): Deterministic test runner, returns structured `{ passed, exitCode, passCount, failCount }`.
- **Pre-rebuild test gate**: Tests must pass before `[REBUILD]` is allowed. Fail-open on gate errors. Uses `testsPassed` boolean flag (not stateful regex).

### Security Fixes
- **CLOUDFLARE_API_TOKEN leak fixed** (`runner.js`): Sandbox users no longer inherit owner's full Cloudflare token. Per-sandbox scoped tokens via `!sandbox cloudflare <phone> <token>`.
- **CLOUDFLARE_ACCOUNT_ID scoped**: Empty for sandbox users.
- **`purgeSandboxUser` hardened** (`sandbox.js`): linuxUser regex validation, absolute paths (`/usr/bin/sudo`, `/usr/sbin/userdel`), `_validateCwd()` for cwd deletion, error logging instead of swallowing.
- **Dockerfile sudoers**: Added `/usr/sbin/userdel` and `/usr/bin/rm` to allowlist for purge support.

### Workspace & Cloudflare
- **Tunnel exponential backoff** (`sandbox-tunnel.js`): 5s→10s→20s...capped at 5min, reset after 30min stability, `reviveTunnel()` export, `--protocol http2` (fixes QUIC timeout issues).
- **`!sandbox purge`**: Removes config + Linux user + home dir + workspace files.
- **`!sandbox cloudflare`**: Sets per-sandbox scoped Cloudflare API tokens.

### Bug Fixes from Review
- **Queue handler missing `planMode`/`reviewMode`**: Queued messages bypassed mode restrictions — fixed.
- **Stateful regex broke rebuild**: `rebuildRe` with `/g` flag caused `.test()` to miss on second call — replaced with boolean flag.
- **Exit-code-2 recovery** (`wsl-autostart.bat`): Fell through to 30s delay on success — fixed with `goto watchdog_retry`.
- **watchdog.sh**: Missing explicit `exit 0` on rebuild success.
- **orchestrate.js**: `codingMode` restoration dropped `undefined` state — always restores now.
- **oncall-watchdog.js**: `escalate()` called with wrong arity, `du` crash on empty dir, tunnel revival without port mappings.
- **sandbox-validation tests**: 12 pre-existing failures fixed — `path.resolve` → `path.posix.resolve` for Windows test host compatibility.

### Test Suite
- **401 tests, 401 pass, 0 failures** (was 389/401 with 12 pre-existing failures).
- **New**: `tests/sandbox-isolation.test.js` (26 tests) — env var scoping, linuxUser validation, tunnel backoff, reviveTunnel state.

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
- **Group membership lost after container recreation**: Bot (+15106412088) is listed as "PENDING" in test groups (boop, Beep, Testing, ppp) and "NOT IN" for Girthy Calamenca 2.0. The signal-cli REST API v0.98 has no endpoint to accept pending invites programmatically. Fix: owner must re-invite bot to those groups via Signal app.
- **No unified notification bus**: 7 independent systems can send unsolicited messages to owner (signal-watchdog, token-refresh, oncall-watchdog, error-alerting, bot.js startup, briefings, monitor-runner). No quiet hours, no consolidation.
- **`autonomous.js` cost tracking not wired**: `MAX_DAILY_COST_USD` declared but `costToday` is always 0 — needs integration with `askClaude` cost reporting.
- **`autonomous.js` timer doesn't survive rebuilds**: `_autonomousTimer` is in-memory. After rebuild, `enabled: true` persists on disk but timer is gone. Needs startup hook to restart if enabled.

### Bugs from 2026-05-22 audit — all fixed (2026-05-23)

All 13 audit bugs fixed, code-reviewed by independent agents, and verified with 375 tests (0 failures):
- **Grouping buffer race**: `state.busy = true` set synchronously before all 6 `_dispatchSignalMessage` callers (3 grouping paths + reaction + resumeChannel + rebuild auto-resume)
- **Spawn double-reject**: `spawnErrorFired` flag prevents duplicate `wrappedReject`/`sendErrorAlert` on error+close
- **Sandbox linuxUser injection**: Regex `/^sandbox-[a-z0-9]{1,20}$/` validation before shell command concatenation
- **`/rebuild` ReferenceError**: `let currentContent = ''` in outer scope
- **`/ask` double-response**: `timedOut` flag + `res.headersSent` guard in close handler
- **`/health/watchdog` auth**: `requireInternalToken` on `/health/watchdog`; `/health` left public (Docker HEALTHCHECK needs it)
- **`isCommandLike` false positives**: `/` prefix only matches known `SLASH_COMMANDS` set; `!` prefix matches broadly
- **Watchdog lag false positives**: Event loop lag check runs first, before I/O-heavy operations
- **Watchdog state mutation**: `releaseSemaphore()` in bot.js with process-liveness check + state persistence
- **`forceKillProcess` hang**: `proc.exitCode !== null` check after listener registration
- **error-alerting init()**: Handles both one-arg and two-arg calling conventions
- **Token refresh cooldown**: `_lastProactiveRefreshAt` stamped after async work completes
- **Headless login timeout leak**: `clearTimeout(urlTimer)` in success, error, and close paths

- **Amazon cart execution via Playwright**: `amazon-cart.js` module provides deterministic cart operations — `checkLoginStatus()`, `addToCart(url)`, `getCartContents()`. Uses Playwright's Node.js API with persistent browser profile at `/app/data/browser-profile`. Stealth settings (custom user agent, webdriver flag removal, AutomationControlled disabled) prevent Amazon's bot detection. Cart fast-path now attempts actual Playwright add-to-cart before falling back to "queued for cart" placeholder.
- **`!amazon` command**: Owner-only Amazon account management — `!amazon status` (check login), `!amazon cart` (view cart), `!amazon login` (interactive login flow). Screenshots sent as Signal attachments.
- **Playwright browser fix**: Dockerfile now installs Chromium using the MCP's bundled Playwright version (not the system's) to prevent version mismatch. `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` ensures browsers are accessible by the `node` user at runtime.

## 24/7 Uptime Requirements
<!-- These are non-negotiable reliability requirements. Do not remove. -->

### WSL Must Stay Up
- **VHDX location**: `D:\WSL\Ubuntu\ext4.vhdx` on external USB HDD. If D: disconnects, WSL dies.
- **Disk monitoring**: `scripts/disk-space-monitor.ps1` runs every 5min. Auto-cleans at <10GB, aggressive at <5GB.
- **Watchdog chain**: Task Scheduler (1min) → `wsl-autostart.bat` → `watchdog.sh` inside WSL. Heartbeat (30s) → `mybot-heartbeat.ps1`.
- **Failure modes covered**: Disk full (auto-cleanup), D: disconnected (USB re-enum), wedged state (force shutdown), HCS timeout (service restart), Docker socket hung (exit code 2), container unhealthy (compose up/rebuild), Windows Update reboot (disabled + AtStartup recovery), memory pressure (.wslconfig limits), log growth (rotation in all scripts).
- **USB power**: Selective suspend disabled, hard disk sleep disabled. Do NOT re-enable.

### Cloudflare Tunnels Must Stay Up
- **Blockbuster tunnel**: PM2 process `cloudflare-tunnel` in `ecosystem.config.js`. Unlimited restarts, HTTP/2 protocol (WSL UDP unreliable). PM2 systemd service waits for `/mnt/c` mount before resurrect.
- **MyBot tunnel**: `sandbox-tunnel.js` inside Docker container. Unlimited restarts with exponential backoff (5s→5min cap, resets after 30min stability). Watchdog revives unconditionally every 2min.
- **Monitoring**: `wsl-autostart.bat` checks PM2 daemon + cloudflare-tunnel status every 1min. `oncall-watchdog.js` check #8 monitors MyBot tunnel every 2min.

### Key Files for Uptime
| File | Purpose | Frequency |
|------|---------|-----------|
| `wsl-autostart.bat` | WSL + Docker + PM2 recovery | 1min (Task Scheduler) |
| `scripts/mybot-heartbeat.ps1` | Health endpoint + disk check | 30s (Task Scheduler) |
| `watchdog.sh` | Container health + disk monitoring | Called by autostart |
| `scripts/disk-space-monitor.ps1` | Tiered disk cleanup | 5min (Task Scheduler) |
| `scripts/install-pm2-service.sh` | PM2 systemd with mount-wait | One-time install |
| `~/.wslconfig` | WSL memory/swap/idle config | On WSL boot |

## Next Steps
- **Register disk-space-monitor task**: Create a 5min-interval Task Scheduler task running `scripts\disk-space-monitor.ps1` (elevated)
- **Move Steam games to D:**: Steam Settings → Storage → Add D:\SteamLibrary → Move games (207 GB)
- **Move Epic Games to D:**: Epic Launcher Settings → Change install to D:\EpicGames → Move games (101 GB)
- **Re-invite bot to groups**: Owner must add +15106412088 back to: Girthy Calamenca 2.0, boop, Beep, Testing, ppp (via Signal app → group settings → Add member)
- **Wire autonomous cost tracking**: Integrate `askClaude` cost reporting into `autonomous.js` so `MAX_DAILY_COST_USD` is enforced
- **Add autonomous startup hook**: Check `autonomous-state.json` `enabled` flag on container start, restart timer if true
- **Build NotificationManager**: Unified notification bus with severity levels, dedup, quiet hours. Replace 7 direct notification paths.
- **Create scoped Cloudflare API tokens**: One per sandbox user via Cloudflare dashboard, then `!sandbox cloudflare <phone> <token>`
- Run `node claude-api/tests/e2e-signal-test.js` to verify all 8 tests pass after any future changes
- Consider bumping `CLAUDE_CODE_VERSION` in docker-compose.yml when a new stable CLI is verified
