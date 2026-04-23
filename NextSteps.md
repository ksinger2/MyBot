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
- **Process management**: MAX_CONCURRENT=2, process registry, priority semaphore (owner evicts non-owner), ghost reaper (60s sweep, kills stale non-owner >15min), queue timeout (30s → friendly busy message)
- **Session lifecycle**: `--resume sessionId` for conversation continuity, 15-min inactivity session expiry, robust error recovery (auto-retry on stale session)
- **Auth failure detection**: CLI "Not logged in" errors surface clearly to user instead of cryptic errors
- **Orphan cleanup**: Only kills truly orphaned processes (ppid=1 or bot-spawned), doesn't touch personal CLI sessions
- **Context persistence**: Recent message log (last 10 per channel, persisted, injected into CLI context)

## Routing Table
| Who | Route | Auth |
|-----|-------|------|
| Karen's DM | CLI (Opus, unlimited) | OAuth `~/.claude.json` |
| Non-owner DM | CLI (Sonnet, 8 turns, tool whitelist) | `ANTHROPIC_API_KEY` |
| Group chat | CLI (Sonnet, 8 turns, tool whitelist) | `ANTHROPIC_API_KEY` |

## What Needs Work (Prioritized)

### P0 — Persistent CLI Sessions
The CLI currently spawns per message and uses `--resume sessionId` for continuity. Karen wants persistent CLI processes that stay alive between messages. The `--input-format stream-json` flag exists but is underdocumented and didn't produce output in testing. Investigation showed:
- `--print` exits after one prompt (can't keep alive)
- stdin text input reads ALL input to EOF as single prompt (no line-by-line)
- `--input-format stream-json` accepts messages but produces zero stdout
When this is properly documented/supported, implement persistent CLI with 15-min inactivity timeout.

### P1 — Future
- Re-authorize Google for Gmail (`!connect` → OAuth flow → `!emaildigest`)
- `!prefs` command for user preference rules
- WhatsApp adapter (explicitly NOT iMessage)
