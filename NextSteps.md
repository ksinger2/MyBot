# MyBot — Next Steps

## What's Working
<!-- Updated each session — 2026-05-17 -->
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
- **Progress circuit breaker with agent awareness**: 3 auto-kill triggers with dynamic thresholds. Default: 15 silent turns / 15min no output / 10min stale. Post-answer agents (answered user, then spawned agent): 8 turns / 5min / 5min. Fail-fast (3+ agent errors or spawn cap exceeded): 3 turns / 2min / 2min. Prevents rogue agents from burning tokens after answering conversational questions.
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
- **Token refresh efficiency**: Tiered approach — (1) sync Windows credentials (free), (2) `claude --version` to trigger SDK auth exchange (free), (3) full CLI prompt only in critical zone (<30min remaining). Previously burned API tokens every 15min on failed refresh attempts.
- **Claude CLI pinned**: `CLAUDE_CODE_VERSION: "2.1.143"` in docker-compose.yml (was "latest" — any rebuild could pull breaking changes).

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
- **Group membership lost after container recreation**: Bot (+15106412088) is listed as "PENDING" in test groups (boop, Beep, Testing, ppp) and "NOT IN" for Girthy Calamenca 2.0. The signal-cli REST API v0.98 has no endpoint to accept pending invites programmatically. Fix: owner must re-invite bot to those groups via Signal app.
- **Sandbox tunnel instability**: Cloudflared QUIC connections frequently timeout and reconnect (non-blocking but noisy logs).
- **No unified notification bus**: 7 independent systems can send unsolicited messages to owner (signal-watchdog, token-refresh, oncall-watchdog, error-alerting, bot.js startup, briefings, monitor-runner). No quiet hours, no consolidation. P1 improvement: build a `NotificationManager` with severity levels, dedup, and quiet hours.

## Recently Fixed (2026-05-17)
- **Rogue agent spawns burning tokens**: Bianca answered conversational questions then autonomously spawned sub-agents ("Investigate signal bridge spam") that got stuck for 10+ minutes. Root cause: system prompt said "Use Agent tool for 2+ independent subtasks" with no guardrails. Fixed with 4-layer defense: (1) system prompt bars self-initiated agents, (2) post-answer agent thresholds (5min kill), (3) consecutive-error fail-fast (3 errors → 2min kill), (4) post-answer spawn cap (3rd agent → immediate fail-fast).
- **Signal bridge restart spam (17 notifications in 24h)**: Watchdog checked `lastDataMessageAt` (text messages only) — 30min gaps with no texts are normal, especially overnight. Triggered false "WebSocket dead" restarts every 30-40 minutes. Fixed: checks `lastWebhookAt` (any envelope — receipts, read notifications) instead, threshold raised to 60min, owner notifications removed entirely (restarts are not user-actionable).
- **Oncall watchdog escalation spam**: `escalate()` sent direct Signal DMs with NO rate limit. Process leak and disk space alerts could fire every 2 minutes indefinitely. Fixed: all escalations route through `sendErrorAlert` for 15-min dedup.
- **Token refresh wasting API tokens**: Proactive refresh ran `claude -p "respond with only the word ok"` (full API call) every 15 minutes when token was low. Even when refresh failed repeatedly, it kept burning tokens. Fixed: tiered approach tries Windows credential sync and `claude --version` (both free) before falling back to expensive CLI prompt only in critical zone (<30min).
- **Claude CLI version unpinned**: `CLAUDE_CODE_VERSION: "latest"` meant any `docker compose up --build` could pull a breaking CLI version. Pinned to 2.1.143.

## Recently Fixed (2026-05-16)
- **Signal WebSocket death (ROOT CAUSE of "bot not working")**: signal-api's WebSocket to Signal servers accumulated 453 drops over 2 weeks, stopped receiving text messages while HTTP health checks still passed 200. Fixed by full container recreation (`docker compose --profile signal stop/rm/up`). Enhanced watchdog now detects this via `lastDataMessageAt` tracking — restarts container if HTTP healthy but no text messages in 30min.
- **`listenToAll` enabled in all group chats**: One-time migration in `channel-persistence.js` resets all groups to `listenToAll: false` on startup. Groups now correctly default to OFF (respond only to @mentions and !commands).
- **Auth errors shown to group chat users**: Both auth failure handlers in bot.js now show "I'm taking a quick break — try again in a few minutes!" instead of technical auth errors. Owner gets a private alert via `sendErrorAlert()`.
- **Remote login from phone (!login command)**: New `commands/login.js` enables owner to re-authenticate Claude CLI remotely via Signal DM. Spawns `claude auth login --claudeai` headlessly, sends auth URL, accepts code back.
- **Login code interception below greeting handler**: Auth code messages were being consumed by the greeting fast-path. Moved login intercept above greeting handler in bot.js.
- **OAuth HTTP refresh broken**: CLIENT_ID was metadata URL, not actual client ID. Removed broken HTTP refresh entirely; bot now uses Windows credential sync + headless login.
- **Stale WebSocket not detected by watchdog**: Enhanced signal-watchdog.js with `recordDataMessage()` separate from `recordWebhookActivity()`. Detects when receipts flow but actual text messages don't.

## Recently Fixed (2026-05-14)
- **TikTok/link messages ignored in group chat**: Merrisa's TikTok links were dropped by the listenToAll filter because messages without question marks or task keywords were classified as "short conversational." Added `hasLink` check — any message with a URL now passes the filter.
- **Admin role bypass**: Admins (SIGNAL_ADMIN_NUMBERS) now bypass both group mention filters and conversational-skip logic, same as owner. Also added to `senderAllowed` check so admins can DM the bot.
- **Runaway owner sessions**: No hard timeout on owner DM sessions allowed stuck sessions to burn tokens indefinitely. Added 60min ceiling + progress circuit breaker (kills after 15 silent turns, 15min no output, or 10min no turn advancement).
- **Stall detector diagnostic dumps in groups**: Group chat stalls sent raw diagnostic info ("Tool at death", "Turns completed"). Now sends friendly "try again" message instead.
- **Stall detector `currentTool` always null**: `currentTool` was cleared immediately in the `tool_use` handler, so the stall detector always used the `thinking` threshold (5min) instead of the `bash` threshold (10min). Moved clear to `tool_result` handler so the correct threshold applies while tools run.
- **Sandbox port registration broken**: `[REGISTER_PORT: PORT]` tag handler replaces broken `curl` approach that relied on scrubbed `$INTERNAL_API_TOKEN`.
- **Signal link formatting lost URLs**: Markdown links with long URLs silently dropped the URL. Now always preserves URL on a separate line.
- **`!plan` venue photos not delivered**: Image paths from earlier turns were lost because `result.text` only contains the final turn, and `strippedImagePaths` (paths stripped during streaming) were never included in the attachment union. Fixed by adding strippedImagePaths as a third source. Streaming proxy also broadened to catch `/workspace/` paths and `.gif` files.
- **`channelProxy is not defined` crash**: Wrong variable name in image delivery code (`channelProxy` → `signalProxy`) caused every Signal session to error after completion.
- **Doubled URLs from webhook re-delivery**: Signal webhook sometimes delivers the same message twice within the 800ms grouping window. The grouping buffer now deduplicates by timestamp + content.
- **Path traversal in strippedImagePaths**: Streaming proxy collected raw paths without `path.resolve()` or directory prefix check. A crafted path like `/tmp/../../etc/...` could bypass containment. Now applies the same resolve + prefix allowlist as `extractImageAttachments`, capped at 10 entries.
- **Sandbox spawn silently falls through**: `_getUid()` cached null UIDs permanently. If the Linux user didn't exist at first lookup (provisioning race, container rebuild), all subsequent sandbox sessions ran as `node` instead of the sandbox user — couldn't write to sandbox dir, stalled for 85min. Fixed: don't cache null, retry provisioning at spawn time, reject with clear error.
- **Circuit breaker false kills on `!plan` / long builds**: `lastOutputTime` only tracked user-visible text, so 15+ minutes of pure tool use (no streamed text) would trigger a kill. `lastTurnTime` didn't reset on tool starts, so a single 12-minute npm install would trigger the 10-min stale check. Fixed: both timers now reset on turn advancement and tool starts.

## Next Steps
- **Re-invite bot to groups**: Owner must add +15106412088 back to: Girthy Calamenca 2.0, boop, Beep, Testing, ppp (via Signal app → group settings → Add member)
- **Build NotificationManager**: Unified notification bus with severity levels (critical/warn/info), dedup by category, quiet hours (11pm-8am), and batched daily digest for low-severity events. Replace all 7 direct notification paths.
- **Add `!alerts` and `!quiet` commands**: View suppressed notifications and toggle quiet hours on/off
- Run `node claude-api/tests/e2e-signal-test.js` to verify all 8 tests pass after any future changes
- Monitor watchdog: `docker compose logs claude-api | grep signal-watchdog`
- Test `!plan` with a venue that has downloadable photos — verify the image arrives as a Signal attachment
- Consider bumping `CLAUDE_CODE_VERSION` in docker-compose.yml when a new stable CLI is verified
