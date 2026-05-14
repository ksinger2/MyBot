# MyBot — Next Steps

## What's Working
<!-- Updated each session — 2026-05-14 -->
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
- **Progress circuit breaker**: 3 auto-kill triggers for owner sessions (15 silent turns, 15min no output, 10min no turn advancement) — prevents runaway token burn. Turn advancement and tool starts both reset timers to avoid false kills on long builds.
- **Group stall detector**: Separate thresholds (2min thinking, 5min bash), friendly "try again" message instead of diagnostic dumps. `currentTool` now correctly tracks active tool (was always null due to premature clear).
- **Group chat link detection**: Messages with URLs now trigger bot response in listenToAll mode even without question marks or task keywords — fixes TikTok/Instagram link sharing being ignored
- **Signal link formatting**: URLs no longer stripped from markdown links — always preserved as clickable text
- **Owner DM safety caps**: 60min hard timeout (was unlimited), 200 max turns (was 1000)
- **Image delivery 3-source union**: Image registry + extractImageAttachments on result.text + strippedImagePaths from streaming proxy. Streaming proxy also strips `/workspace/` paths and `.gif` files. All paths validated with `path.resolve()` + directory prefix check.
- **Message grouping dedup**: Duplicate webhook deliveries (same timestamp + content) are now dropped before entering the grouping buffer — prevents doubled URLs/content.
- **Sandbox UID resolution**: `_getUid()` no longer caches null results. Runner retries provisioning at spawn time if UID is missing, and rejects with a clear error instead of silently falling through to non-sandbox mode.

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
- (none currently tracked)

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
- Have Merrisa send a TikTok link in the group chat to confirm the fix is live
- Have Daniel test a DM session — verify sandbox spawn works (check logs for `unshare` instead of plain `claude` spawn)
- Test `!plan` with a venue that has downloadable photos — verify the image arrives as a Signal attachment
- Test `!plan` follow-ups (e.g. "send me a link") correctly reference `state._lastPlan`
- Monitor progress circuit breaker: `docker compose logs claude-api | grep progress-breaker`
