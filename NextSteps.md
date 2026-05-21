# MyBot — Next Steps

## What's Working
<!-- Updated each session — 2026-05-20 -->
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
- **Command context continuity**: Commands (`!product`, `!help`, etc.) now record both the user's command and the bot's reply in `recentMessages`. Follow-up questions ("how much are those?") have full context about what the command found. Implemented via reply/send proxy wrapper in bot.js.
- **Product query cleaning**: `cleanProductQuery()` strips conversational filler from natural language product requests, extracts store preference (Amazon/Walmart/Target), and preserves brand names. "add a nice and good deal product to my amazon cart that is a planter, 8 ft long" → query: "planter 8 ft long", store: amazon.
- **Cart approval fast-path (deterministic)**: "1", "add 1", "add all" now processed directly via `approvalGate` without spawning Claude — same pattern as the greeting fast-path. 👍 reactions on cart prompts (identified by 🛒 prefix, which is infrastructure-generated) also auto-approve directly. Pending items cleared after processing to prevent duplicate execution. Previously, both paths spawned a full Claude CLI session that had to figure out it should emit `[CART_ADD: action="add" ids="1"]` — which stalled at turn 0 twice in a row.
- **Content-based message dedup**: New early dedup layer catches Signal re-deliveries with different timestamps but identical normalized content (e.g. with/without U+FFFC prefix). Keyed on `chatId:senderId:normalizedContent` with 2s window. Runs before command handler — fixes duplicate `!listen on` responses.
- **Parallel link enrichment**: Link metadata, TikTok transcripts, Instagram transcripts, and auto-context now fetch in parallel via `Promise.all`. Response time for link messages drops from ~25s (sequential) to ~10s (max of individual fetches).

## Recently Fixed (2026-05-20)
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
