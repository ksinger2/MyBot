# MyBot — Session Handoff (2026-03-12)

## What's Working
- Discord bot (**BiancaDaCow**) is live and responding in Discord
- Claude Code CLI integration working (subscription-based, not API)
- Per-channel session persistence, identity/personality switching
- Morning briefing system (scheduled 9am PT daily + `!briefing` on-demand)
- Sunday weekly preview (`!weekly` on-demand, auto at noon Sundays)
- Evening check-in at 10pm PT — bot asks for tomorrow's tasks via wizard
- Briefing modules: stocks (with portfolio tracking), weather, news, jobs, tasks, mindfulness
- Discord embed suppression via `MessageFlags.SuppressEmbeds` on briefing messages
- Image attachment support — bot auto-attaches images referenced in Claude's responses
- `!restart` command — bot restarts itself, notifies the channel when it's back up
- `!email` command — drafts 3 professional email options in different tones
- `!processes` command — shows active Claude processes and resource usage
- `!btw` command — structured progress peek: current tool, file path, turn count, listening ports, other CLI sessions
- `!startproject` wizard — creates new project with Claude Code template, agents, skills, commands, and optional git/GitHub setup
- `!cancel` command — cancel an active wizard mid-flow
- Generic wizard system for multi-step interactive commands
- Docker control — Claude has full Docker access inside the container (socket mounted)
- Error alerting — all errors posted to `#bot-errors` channel with dedup (5min per error type)

## Architecture
```
Discord message → Discord.js bot (claude-api container) → Claude CLI (stream-json) → reply to Discord
```
- `claude-api/` container: Express server (port 3400) + Discord.js bot
- n8n removed (was unused — no Discord nodes in n8n 2.11.2)
- Claude CLI authenticates via mounted credentials from host
- Claude CLI uses `--output-format stream-json --verbose` for structured progress tracking
- Docker socket mounted + `group_add: ["989"]` gives Claude container management access

## What Was Done This Session

### New Features
- **Error alerting** (`error-alerting.js`) — All errors (CLI failures, timeouts, briefing failures, wizard errors) posted to `#bot-errors` Discord channel. 5-minute dedup per error type prevents spam. Shows error source, channel link, message, and relative timestamp.
- **`!btw` rewrite** — Switched from raw stderr to stream-json NDJSON parsing. Now shows: current tool + file path (e.g. "Editing `bot.js`"), turn count, tool history breadcrumb trail, listening ports, and other active Claude CLI sessions.
- **Stream-json migration** — `askClaude()` switched from `--output-format json` to `--output-format stream-json --verbose`. Parses structured events in real-time for progress tracking while preserving the same return contract.
- **n8n removed** — Unused n8n service stripped from docker-compose.yml, container stopped, volume deleted.
- **Brevity improvements** — Tightened system prompt with hard sentence limits (2-4 simple, 6-8 complex). Personality is "seasoning not the dish" (10-20%). Trimmed personality file examples.

### Previous Session Features (already committed)
- `!btw`, `!processes`, `!startproject` wizard, Sunday weekly preview, generic wizard system
- Project template with 12 agents, 3 commands, verification skill
- Embed suppression fix, evening check-in refactored to wizard system

## Likely Next Steps

### 1. Test new features in Discord
- Send a message, then run `!btw` — verify it shows tool name, file path, turn count
- Trigger an error — verify it appears in `#bot-errors`
- Confirm responses are shorter with updated brevity rules

### 2. More personalities
- Add new personality files in `claude-api/personalities/`

### 3. Additional monitoring
- Track briefing success/failure rate over time
- Add health check alerts if container goes unhealthy

## Key Files
| File | Purpose |
|------|---------|
| `claude-api/bot.js` | Discord bot — message handling, Claude CLI spawn (stream-json), commands, wizard integration |
| `claude-api/error-alerting.js` | Error alerting — posts errors to #bot-errors with dedup |
| `claude-api/wizard.js` | Generic multi-step wizard engine |
| `claude-api/wizards/startproject.js` | `!startproject` wizard definition |
| `claude-api/briefings.js` | Briefing system — data fetchers, prompt builder, scheduler, weekly preview |
| `claude-api/briefing-config.js` | Briefing config — tickers, weather, news topics, job search, schedules, error channel |
| `claude-api/tasks-storage.js` | Task persistence — save/load/clear tasks for briefing |
| `claude-api/project-template/` | Full Claude Code project template (CLAUDE.md, agents, commands, skills) |
| `claude-api/personalities/tiffany_pollard.md` | Main personality file |
| `claude-api/server.js` | Express server + bot startup |
| `claude-api/Dockerfile` | Node 20, Claude CLI, Docker CLI, copies all .js + wizards + template |
| `docker-compose.yml` | Single service (claude-api), healthcheck, Docker socket mount |
| `.env` | Secrets (not committed) |
