# MyBot — Next Steps

## Current State
Branch: `stable-rebuild`

## What's Working
- **Signal-only architecture**: Discord fully removed. Signal via bbernhard/signal-cli-rest-api.
- **Owner DM**: Full Claude Code CLI (Opus, OAuth via ~/.claude.json, unlimited turns, all tools)
- **Non-owner DM / Groups**: CLI with Sonnet, tool whitelist (Read,WebSearch,WebFetch,Task,TodoWrite), 8-turn cap, personality applied
- **Voice pipeline**: STT/TTS, Siri endpoint at /voice
- **All plugins**: weather, calendar, product search, concert tracker, EightSleep, Spotify
- **Action tags**: [EVENT:], [REMIND:], [CALENDAR:], [WEATHER:], [IMAGINE:], [EIGHTSLEEP:], [PRODUCT:], [LEARNED:], [SET_PREF:], etc. — all processed server-side
- **Email digest** (`!emaildigest`): Gmail read, categorize, mark read, unsubscribe via Haiku
- **Privacy hardening**: PII filters, INTERNAL_API_TOKEN protection, MCP blocking for non-owners
- **Session journal**: Per-channel CLI session summaries, injected into next session's system prompt
- **Process management**: MAX_CONCURRENT=4, process registry, priority semaphore (owner evicts non-owner), ghost reaper (60s sweep, kills stale non-owner >15min), queue timeout (30s → friendly busy message)
- **Session lifecycle**: `--resume sessionId` for conversation continuity, 15-min inactivity session expiry, robust error recovery (auto-retry on stale session)
- **Auth failure detection**: CLI "Not logged in" errors surface clearly to user instead of cryptic errors
- **Orphan cleanup**: Only kills truly orphaned processes (ppid=1 or bot-spawned), doesn't touch personal CLI sessions
- **Context persistence**: Recent message log (last 10 per channel, persisted, injected into CLI context)
- **Session commands**: `!compact` (reset session, keep recent context), `!session`/`!sesh` (show session stats — turns, cost, age, cap usage), `!clear` (full reset)
- **Session tracking**: Cumulative cost and turns tracked per session, persisted across restarts
- **Cost guardrails**: Per-channel session cost cap via `!config cost <$>`, auto-clears session when exceeded
- **Background tasks**: `!bg <task>` fires off a Claude task in background, `!bgtasks` to check status/results, auto-notifies on completion
- **Agent SDK runner**: `@anthropic-ai/claude-agent-sdk` integration via `USE_SDK_RUNNER=true` env var. Uses V1 `query()` API with session resume, streaming, tool allowlists, same security hardening as CLI runner. Opt-in while stabilizing.

## Routing Table
| Who | Route | Auth |
|-----|-------|------|
| Karen's DM | CLI (Opus, unlimited) | OAuth `~/.claude.json` |
| Non-owner DM | CLI (Sonnet, 8 turns, tool whitelist) | `ANTHROPIC_API_KEY` |
| Group chat | CLI (Sonnet, 8 turns, tool whitelist) | `ANTHROPIC_API_KEY` |

## What Needs Work (Prioritized)

### P0 — SDK Runner Stabilization
The Agent SDK runner (`sdk-runner.js`) is built and wired in behind `USE_SDK_RUNNER=true`. Needs production testing:
- Verify streaming works end-to-end (SDK emits SDKMessage objects, not raw stdout)
- Verify session resume via `query({ options: { resume: sessionId } })`
- Verify tool allowlists and permission bypass work correctly
- Test auth failure detection paths
- Test `!stop` with SDK query handle (`.close()`)
- Benchmark startup latency vs raw CLI spawn
- Consider using `startup()` for pre-warming the CLI subprocess

### P1 — Future
- Re-authorize Google for Gmail (`!connect` → OAuth flow → `!emaildigest`)
- `!prefs` command for user preference rules
- WhatsApp adapter (explicitly NOT iMessage)
- Context size tracking (SDK `getContextUsage()` available in V1 query API)
- Per-conversation tool scoping command (`!tools` to restrict/expand tool access per channel)
