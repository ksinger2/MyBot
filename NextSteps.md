# MyBot — Next Steps

## What's Working
<!-- Updated each session — 2026-05-21 -->
- On-call watchdog (`oncall-watchdog.js`) running every 2min with 6 deterministic health checks:
  1. CLI auth health (escalates after 3 failures, 30min cooldown)
  2. Sandbox credential freshness (auto-refreshes if >5min stale)
  3. Process leak detection (kills orphan claude processes >10, escalates node >20)
  4. Disk space monitoring (/tmp sweep at 80%, escalate /app/data at 90%)
  5. Event loop lag (graceful restart after 3 consecutive >30s readings)
  6. Semaphore leak detection (clears stuck busy channels with dead processes)
- `/health/watchdog` endpoint returns rolling health report (last 10 cycles)
- `/health` endpoint now uses watchdog's cached CLI result (no redundant spawns)
- Sandbox auth hardening: 3-layer defense (per-spawn refresh + 60s periodic + auth-failure retry)
- All sandbox users (Merrisa, Daniel, Lee) have fresh creds and are ready
- Missed-message recovery: on restart, detects webhook gaps >90s via persisted timestamp (`/app/data/watchdog-state.json`), proactively messages recently active chats to resend. Guards against null adapter, double-notify with auto-resume, and logs write failures.
- Owner DM now uses `claude-opus-4-6` (200k context) with high effort (was `claude-opus-4-7`)
- `!reinit` command and `/reinit` skill wired up (command-utils.js, reinit-prompt.js, commands/reinit.js)
- Queue runner now passes a proper ChannelProxy to `runClaudeWithContinuation` for progress messages
- `isCommandLike()` utility replaces raw `text.startsWith('!')` checks (supports `/` prefix too)
- Google auth token reconciliation now cross-references UUID↔phone map for accurate token lookup
- Concert price scraper now deterministic: `auto-context.js` detects ticket/price intent, extracts artist names, pre-fetches from scraper, injects `<concert-price-data>` into prompt — no tag emission needed from Claude
- **OAuth token auto-refresh**: `token-refresh.js` now does real OAuth2 refresh via `https://api.anthropic.com/token` using the refresh_token, syncs from Windows credentials mount — bot never loses auth even overnight
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
- **Token refresh efficiency**: Tiered approach — (1) sync Windows credentials (free), (2) `claude -p "ok"` to force SDK through OAuth exchange (triggers actual token refresh). Runs whenever token < 2hr remaining. Queue and direct paths both retry once on auth failure before alerting owner.
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

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
- **Group membership lost after container recreation**: Bot (+15106412088) is listed as "PENDING" in test groups (boop, Beep, Testing, ppp) and "NOT IN" for Girthy Calamenca 2.0. The signal-cli REST API v0.98 has no endpoint to accept pending invites programmatically. Fix: owner must re-invite bot to those groups via Signal app.
- **Sandbox tunnel instability**: Cloudflared QUIC connections frequently timeout and reconnect (non-blocking but noisy logs).
- **No unified notification bus**: 7 independent systems can send unsolicited messages to owner (signal-watchdog, token-refresh, oncall-watchdog, error-alerting, bot.js startup, briefings, monitor-runner). No quiet hours, no consolidation. P1 improvement: build a `NotificationManager` with severity levels, dedup, and quiet hours.

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

## Next Steps
- **Re-invite bot to groups**: Owner must add +15106412088 back to: Girthy Calamenca 2.0, boop, Beep, Testing, ppp (via Signal app → group settings → Add member)
- **Build NotificationManager**: Unified notification bus with severity levels (critical/warn/info), dedup by category, quiet hours (11pm-8am), and batched daily digest for low-severity events. Replace all 7 direct notification paths.
- **Add `!alerts` and `!quiet` commands**: View suppressed notifications and toggle quiet hours on/off
- Run `node claude-api/tests/e2e-signal-test.js` to verify all 8 tests pass after any future changes
- Monitor watchdog: `docker compose logs claude-api | grep signal-watchdog`
- Test `!plan` with a venue that has downloadable photos — verify the image arrives as a Signal attachment
- Consider bumping `CLAUDE_CODE_VERSION` in docker-compose.yml when a new stable CLI is verified
