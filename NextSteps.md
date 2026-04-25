# MyBot — Next Steps

## Current State
Branch: `stable-rebuild`

## What's Working
- **Signal-only architecture**: Discord fully removed. Signal via bbernhard/signal-cli-rest-api.
- **Owner DM — Autonomous Agent Mode**: Full Claude Code CLI (Opus 4.7, OAuth via ~/.claude.json, unlimited turns, all tools). Bianca identity and Tiffany Pollard personality always applied. System prompt orients Bianca as an autonomous coding agent: she navigates /workspace/ projects, edits files, runs builds, deploys — without asking for permission.
- **OWNER_FULL_ACCESS gate**: Env var (default: true) controls whether owner DM gets full engineering tools or restricted read-only. When false, owner DM becomes a research-only assistant.
- **Non-owner DM / Groups**: CLI with Sonnet, tool whitelist (Read,WebSearch,WebFetch,Task,TodoWrite), 8-turn cap, personality applied
- **Voice pipeline**: STT/TTS, Siri endpoint at /voice. PIN-authenticated, runs as owner (OAuth), uses Haiku for speed. Auth failures surface clearly instead of silent fallback.
- **All plugins**: weather, calendar, product search, concert tracker, EightSleep, Spotify
- **Action tags**: [EVENT:], [REMIND:], [CALENDAR:], [WEATHER:], [IMAGINE:], [EIGHTSLEEP:], [PRODUCT:], [LEARNED:], [SET_PREF:], [BACKGROUND:], etc. — all processed server-side
- **Google Calendar MCP**: Connected. System prompt explicitly tells Bianca to use Calendar MCP for reminders/events (not the schedule Skill, which is for bot-internal cron jobs).
- **Email digest** (`!emaildigest`): Gmail read, categorize, mark read, unsubscribe via Haiku
- **Security hardening**: Security headers (X-Content-Type-Options, X-Frame-Options, CSP on /setup and /debug), rate limiting on /voice, debug upload auth tokens, port binding to 127.0.0.1, PII filters, INTERNAL_API_TOKEN closure pattern, MCP blocking for non-owners
- **Session journal**: Per-channel CLI session summaries, injected into next session's system prompt
- **Process management**: MAX_CONCURRENT=4, process registry, priority semaphore (owner evicts non-owner), ghost reaper (60s sweep, kills stale non-owner >15min), queue timeout (30s → friendly busy message)
- **Session lifecycle**: `--resume sessionId` for conversation continuity, 15-min inactivity session expiry, robust error recovery (auto-retry on stale session)
- **Auth failure detection**: CLI "Not logged in" errors surface clearly to user instead of cryptic errors. Voice/Siri path explicitly catches auth failures and notifies via Signal.
- **Orphan cleanup**: Only kills truly orphaned processes (ppid=1 or bot-spawned), doesn't touch personal CLI sessions
- **Context persistence**: Recent message log (last 10 per channel, persisted, injected into CLI context)
- **Session commands**: `!compact` (reset session, keep recent context), `!session`/`!sesh` (show session stats — turns, cost, age, cap usage), `!clear` (full reset)
- **Session tracking**: Cumulative cost and turns tracked per session, persisted across restarts. Reset on session clear, expiry, or resume failure.
- **Cost guardrails**: Per-channel session cost cap via `!config cost <$>`, auto-clears session when exceeded. Displayed in `!session` with percentage used.
- **Background tasks**: `!bg <task>` fires off a Claude task in background, `!bgtasks` to check status/results, auto-notifies on completion. Bianca can also spawn background tasks naturally via `[BACKGROUND: description | prompt]` action tag.
- **Agent SDK runner**: `@anthropic-ai/claude-agent-sdk` (v0.2.118) integration via `USE_SDK_RUNNER=true` env var. Opt-in while stabilizing.

## Routing Table
| Who | Route | Auth | Model |
|-----|-------|------|-------|
| Karen's DM | CLI (unlimited, personality, autonomous agent) | OAuth `~/.claude.json` | Opus 4.7 |
| Karen's Siri | CLI (3 turns, voice mode) | PIN + OAuth | Haiku |
| Non-owner DM | CLI (8 turns, tool whitelist) | `ANTHROPIC_API_KEY` | Sonnet |
| Group chat | CLI (8 turns, tool whitelist) | `ANTHROPIC_API_KEY` | Sonnet |

## What Was Fixed (2026-04-25)
- **Identity**: Default changed from "My Bot" to "Bianca" with autonomous agent description. Persisted channel states with old "My Bot" identity auto-migrate on load.
- **Owner DM system prompt**: Rewritten to orient Bianca as an autonomous coding agent — multi-project navigation, end-to-end execution, no permission-asking. Explicit Calendar MCP guidance to prevent schedule Skill confusion.
- **OWNER_FULL_ACCESS**: Defaults to true so owner DM gets full engineering tools out of the box.
- **Security hardening**: Server security headers, rate limiter with periodic cleanup, debug upload auth tokens with double-response guard, /ask endpoint uses --allowedTools + --dangerously-skip-permissions (both needed for non-interactive execution), port binding to localhost only, concert-scraper port changed to expose-only.

## What Needs Work (Prioritized)

### P0 — OAuth Re-auth (BLOCKER)
The OAuth token in `~/.claude.json` is expired. Every background task (AI Pulse, Media Pulse, Morning Briefing) and voice/Siri request fails with "Not logged in · Please run /login". To fix:
1. Run `claude` in a terminal on the host
2. Run `/login` inside the CLI
3. Re-auth completes → token refreshed → container picks it up via bind mount

### P1 — SDK Runner Stabilization
The Agent SDK runner (`sdk-runner.js`) is built and wired in behind `USE_SDK_RUNNER=true`. Needs production testing:
- Verify streaming works end-to-end (SDK emits SDKMessage objects, not raw stdout)
- Verify session resume via `query({ options: { resume: sessionId } })`
- Verify tool allowlists and permission bypass work correctly
- Test auth failure detection paths
- Test `!stop` with SDK query handle (`.close()`)
- Benchmark startup latency vs raw CLI spawn

### P2 — Future
- Re-authorize Google for Gmail (`!connect` → OAuth flow → `!emaildigest`)
- `!prefs` command for user preference rules
- WhatsApp adapter (explicitly NOT iMessage)
- Context size tracking (SDK `getContextUsage()` available in V1 query API)
- Per-conversation tool scoping command (`!tools` to restrict/expand tool access per channel)
