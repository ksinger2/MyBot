# MyBot — Session Handoff (2026-04-08)

## Current Status
- Bot is running via `docker compose up -d --build` from the MyBot directory
- Docker Engine in WSL (v29.3.1), `restart: unless-stopped` for crash recovery
- All features deployed and healthy
- **Major overhaul completed** — reliability fixes, PM2 services, Playwright MCP, Signal adapter

## What's Working
- Discord bot (**BiancaDaCow**) is live and responding
- Claude Code CLI integration (subscription-based, stream-json)
- Per-channel session persistence, identity/personality switching
- Morning briefing (9am PT), weekly preview (Sunday noon), evening check-in (10pm PT)
- AI News Pulse (8am, 11am, 2pm, 5pm PT) with recency-first ordering
- Image generation, web browsing (WebSearch/WebFetch), sub-agent tracking
- All Discord commands (`!stop`, `!clear`, `!kill`, `!restart`, `!config`, `!services`, etc.)
- Smart link handler (TikTok, YouTube, Yelp, Instagram, etc.)
- Error alerting to `#bot-errors` with dedup
- Auto-resume after crash, crash-loop recovery (3x in 2min → rollback)
- Safe-rebuild with last-known-good snapshot

### New: Critical Bug Fixes (2026-04-08)
- **`forceKillProcess` helper** — SIGTERM → wait 3s → SIGKILL at every kill site
- **`!clear` now kills active processes** — no more "use !stop first" friction
- **Graceful shutdown** — waits for all child processes before exit (5s cap)
- **Queue drain race condition fixed** — `state.busy = true` before splice
- **Auto-resume race condition fixed** — `state.busy = true` before async work
- **Queue file locking** — lockfile prevents duplicate processing across instances
- **Stall detector respects sub-agents** — 30min minimum threshold when agents active
- **Hard timeout graceful kill** — saves state before rejecting
- **Critical persistence flush** — activeTask/queue changes write immediately (no debounce)
- **Long response upload** — responses >8 chunks upload as .txt file attachment

### New: Session Continuity
- **Configurable limits** — `DEFAULT_MAX_TURNS`, `MAX_AUTO_CONTINUES`, `MAX_TIMEOUT_MINUTES` via env vars
- **`!config` command** — per-channel overrides: `!config turns 200`, `!config timeout 240`
- **Reliable session journal** — atomic writes, 3x retry, error alerting
- **Mandatory session handoff** — auto-updates NextSteps.md when turn limit exhausted

### New: PM2 Background Services
- **PM2 installed globally** in Docker image
- **Lifecycle management** — `pm2 resurrect` on startup, `pm2 dump` on shutdown
- **`!services`** — list running PM2 processes (name, status, PID, memory, uptime)
- **`!service stop|logs <name>`** — manage individual services
- **System prompt** tells Claude to always use PM2 for dev servers

### New: Playwright MCP Integration
- **Chromium installed** in Docker image with all dependencies
- **`--mcp-config`** passed to Claude CLI subprocess
- **System prompt enables Playwright** — for QA, visual testing, bug hunting
- **Mobile device emulation** — iPhone 14 (390x844), Pixel 7 (412x915), iPad (820x1180)
- **Test-fix-retest loop** — system prompt instructs Claude to always verify visually

### New: Project Commands
- **`/reinit` enhanced** — checks PM2 services, health checks, settings
- **`/bug-list` created** — automated Playwright crawl → screenshot → bug report → auto-fix loop
- **Auto-injection** — commands copied into existing projects on first askClaude call

### New: Signal Adapter
- **Reusable adapter layer** at `claude-api/adapters/` — `MessagePlatform` base class
- **`DiscordAdapter`** — wraps discord.js with normalized interface
- **`SignalAdapter`** — uses `bbernhard/signal-cli-rest-api` REST sidecar
- **Docker Compose** — signal-api service with `--profile signal` (opt-in)
- **Bot integration** — Signal messages route through same Claude pipeline as Discord
- **Access control** — `SIGNAL_ALLOWED_NUMBERS` env var for phone number whitelist

### AI News Pulse
- Runs at 8am, 11am, 2pm, 5pm PT (was 24/7 every 3h)
- Recency-first ordering with time-ago tags
- 14 news sources including arXiv, MIT Tech Review, NYT, ProductHunt, Reddit
- 5 max turns per run (was 10)

## Architecture
```
Discord message → Discord.js bot (claude-api container) → Claude CLI (stream-json) → reply to Discord
Signal message  → SignalAdapter (polling signal-api) → Claude CLI (stream-json) → reply to Signal
```
- `claude-api/` container: Express server (port 3400) + Discord.js bot + Signal adapter
- `signal-api/` container: signal-cli-rest-api sidecar (port 8080, profile: signal)
- Claude CLI authenticates via mounted credentials from host
- Docker socket mounted for self-rebuild capability
- PM2 manages background dev servers, state persists across restarts

## Key Files
| File | Purpose |
|------|---------|
| `claude-api/bot.js` | Main bot — commands, Claude CLI wrapper, system prompt, Signal integration |
| `claude-api/adapters/base.js` | MessagePlatform base class — reusable adapter interface |
| `claude-api/adapters/discord.js` | DiscordAdapter — normalized discord.js wrapper |
| `claude-api/adapters/signal.js` | SignalAdapter — signal-cli-rest-api client |
| `claude-api/adapters/index.js` | Adapter factory and exports |
| `claude-api/server.js` | Express server — `/ask`, `/imagine`, `/health`, OAuth callbacks |
| `claude-api/channel-persistence.js` | Channel state persistence with critical flush |
| `claude-api/session-journal.js` | Reliable session journal with atomic writes |
| `claude-api/queue-storage.js` | Queue with file locking |
| `claude-api/ai-news.js` | AI news pulse — 4x/day, recency-first |
| `claude-api/project-template/.claude/commands/bug-list.md` | /bug-list — automated Playwright QA |
| `docker-compose.yml` | Container config, env vars, volume mounts, signal-api sidecar |

## Environment Variables
```
DISCORD_BOT_TOKEN=...
OPENAI_API_KEY=...              # for image generation

# Access control
ALLOWED_USER_IDS=               # comma-separated Discord user IDs
ADMIN_USER_IDS=                 # comma-separated admin user IDs

# Session limits (optional)
DEFAULT_MAX_TURNS=50
MAX_AUTO_CONTINUES=3
MAX_TIMEOUT_MINUTES=90

# Signal (optional — set phone number to enable)
ENABLED_PLATFORMS=discord       # add signal: ENABLED_PLATFORMS=discord,signal
SIGNAL_PHONE_NUMBER=            # e.g. +1234567890
SIGNAL_API_URL=http://signal-api:8080
SIGNAL_ALLOWED_NUMBERS=         # comma-separated phone numbers
SIGNAL_POLL_INTERVAL=5000

# Google OAuth (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Spotify OAuth (optional)
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

## Next Steps
1. **Set up Signal** — Register a phone number with signal-cli, add to .env, test with `docker compose --profile signal up -d`
2. **Test Playwright MCP** — `!startproject test-app`, build a simple web page, run `/bug-list`
3. **Test `!config`** — `!config turns 200` for long autonomous sessions
4. **Test `!services`** — have Claude start a dev server with PM2, verify persistence
5. **iMessage adapter** — research BlueBubbles setup on Mac for iMessage bridge
6. **WhatsApp adapter** — only via official Business API if needed
7. **Commit and push** — all changes are local, need git commit
