# MyBot — Session Handoff (2026-04-09)

## Current Status
- Bot is running via `docker compose --profile signal up -d --build`
- Docker Engine in WSL (v29.3.1), `restart: unless-stopped` for crash recovery
- All features deployed and healthy — Discord + Signal both active
- **OpenClaw-level autonomy overhaul completed**

## What's Working
- Discord bot (**BiancaDaCow**) is live and responding
- **Signal bot** (+1 510-641-2088) is live and responding
- Claude Code CLI integration (subscription-based, stream-json)
- Per-channel session persistence, identity/personality switching
- Morning briefing (9am PT), weekly preview (Sunday noon), evening check-in (10pm PT)
- AI News Pulse (8am, 11am, 2pm, 5pm PT) with recency-first ordering
- Image generation, web browsing (WebSearch/WebFetch), sub-agent tracking
- All Discord commands work on Signal too (same `!command` syntax)
- Smart link handler, error alerting, auto-resume, crash-loop recovery, safe-rebuild

### Autonomy Features (2026-04-09)
- **ChannelProxy** — platform-agnostic feedback channel. Signal now gets stall warnings, loop detection, turn limit messages, progress updates (was completely broken before)
- **!loop <task>** — autonomous loop: runs Claude repeatedly until task done (max 10 iterations). Reads NextSteps.md between iterations for context. Stops on "TASK COMPLETE"
- **Persistent memory** — `MEMORY.md` (long-term) + `memory/YYYY-MM-DD.md` (daily notes) in `.claude/memory/`. Auto-injected into every new session. Claude saves learnings across sessions
- **Heartbeat & standing orders** — `!heartbeat <minutes>` wakes Claude periodically to check `AGENTS.md` for autonomous work. Silent mode when nothing to do
- **Task ledger** — tracks all background sub-agent work with status, timing, results
- **Self-edit safety** — system prompt forbids self-editing from Signal, enforces syntax-check before rebuild, one-change-at-a-time rule
- **MAX_AUTO_CONTINUES** increased from 3 to 5 for longer autonomous sessions

### Reliability Fixes (2026-04-08)
- **forceKillProcess** — SIGTERM → SIGKILL escalation at every kill site
- **!clear** now kills active processes (no more "use !stop first")
- **Graceful shutdown** waits for children (5s cap)
- **Race conditions fixed** — queue drain + auto-resume
- **Queue file locking** — prevents duplicate processing
- **Stall detector** respects sub-agents (30min threshold)
- **Hard timeout** graceful kill + state persistence
- **Critical persistence** flush bypasses debounce
- **Long responses** upload as .txt when >8 chunks

### Session Continuity
- Configurable limits via env vars + `!config` per-channel overrides
- Reliable session journal (atomic writes, 3x retry, error alerting)
- Mandatory NextSteps.md handoff on turn limit exhaustion

### PM2 Background Services
- PM2 installed, lifecycle in entrypoint (resurrect/dump)
- `!services` / `!service stop|logs <name>` commands
- System prompt tells Claude to always use PM2 for dev servers

### Playwright MCP
- Chromium installed, `--mcp-config` passed to CLI
- Mobile device emulation (iPhone 14, Pixel 7, iPad)
- Test-fix-retest loop in system prompt

### Project Commands
- `/reinit` — enhanced with PM2/health checks
- `/bug-list` — Playwright crawl → bug report → auto-fix loop
- Auto-injected into existing projects

### Signal Adapter
- Reusable adapter layer at `claude-api/adapters/`
- `bbernhard/signal-cli-rest-api` sidecar (opt-in `--profile signal`)
- Bot registered at +1 (510) 641-2088
- Access control via `SIGNAL_ALLOWED_NUMBERS`

## Architecture
```
Discord message → ChannelProxy → Claude CLI (stream-json) → ChannelProxy → Discord reply
Signal message  → ChannelProxy → Claude CLI (stream-json) → ChannelProxy → Signal reply
Heartbeat timer → AGENTS.md + NextSteps.md → Claude CLI → ChannelProxy → reply (or silent)
!loop iteration → NextSteps.md context → Claude CLI → ChannelProxy → check done → repeat
```

## Key Files
| File | Purpose |
|------|---------|
| `claude-api/bot.js` | Main bot — ChannelProxy, commands, Claude CLI wrapper, system prompt |
| `claude-api/memory.js` | Persistent memory system (MEMORY.md + daily notes) |
| `claude-api/heartbeat.js` | Heartbeat & standing orders (AGENTS.md) |
| `claude-api/task-ledger.js` | Background task tracking |
| `claude-api/adapters/base.js` | MessagePlatform base class |
| `claude-api/adapters/signal.js` | SignalAdapter (signal-cli REST client) |
| `claude-api/adapters/discord.js` | DiscordAdapter (normalized wrapper) |
| `claude-api/ai-news.js` | AI news pulse (4x/day) |
| `claude-api/channel-persistence.js` | Channel state with critical flush |
| `claude-api/session-journal.js` | Reliable session journal |
| `claude-api/queue-storage.js` | Queue with file locking |
| `claude-api/project-template/.claude/commands/bug-list.md` | /bug-list command |
| `docker-compose.yml` | Container config + signal-api sidecar |

## Environment Variables
```
DISCORD_BOT_TOKEN=...
OPENAI_API_KEY=...

# Access control
ALLOWED_USER_IDS=               # Discord user IDs
ADMIN_USER_IDS=                 # Admin user IDs

# Session limits
DEFAULT_MAX_TURNS=50
MAX_AUTO_CONTINUES=5
MAX_TIMEOUT_MINUTES=90

# Signal
ENABLED_PLATFORMS=discord,signal
SIGNAL_PHONE_NUMBER=+15106412088
SIGNAL_API_URL=http://signal-api:8080
SIGNAL_ALLOWED_NUMBERS=
SIGNAL_POLL_INTERVAL=5000

# Google/Spotify OAuth (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

## Discord Commands (all work on Signal too)
**Control:** `!stop`, `!clear`, `!kill`, `!killall`, `!restart`, `!refresh`, `!status`, `!btw`, `!processes`, `!cancel`
**Workspace:** `!cd`, `!ls`, `!startproject`
**Identity:** `!name`, `!identity`, `!personality`, `!personalities`
**Config:** `!config show|turns|continues|timeout <N>`
**Autonomy:** `!loop <task>`, `!heartbeat <minutes>|off|status`, `!orders`
**Services:** `!services`, `!service stop|logs <name>`
**Tasks:** `!tasks`, `!done`
**Schedule:** `!schedule`, `!schedules`, `!unschedule`, `!autoschedule`
**Queue:** `!queue`, `!queued`, `!dequeue`
**Monitors:** `!monitor ci|health|remove|pause|resume|check`
**Briefing:** `!briefing`, `!weekly`, `!ainews`
**Other:** `!email`, `!imagine`, `!preview`, `!help`

## Next Steps
1. **Test Signal autonomous work** — send a coding task via Signal, verify full feedback loop works
2. **Test !loop** — `!loop "build a simple todo app"` and verify it completes autonomously
3. **Create AGENTS.md** — define standing orders for a project, test with `!heartbeat 30`
4. **Test Playwright MCP** — `!startproject test-app`, build a web page, run `/bug-list`
5. **iMessage adapter** — research BlueBubbles on Mac
6. **Explore OpenClaw integration** — consider using OpenClaw as the gateway instead of custom bot
