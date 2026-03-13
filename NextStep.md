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
- `!btw` command — peek at Claude's progress (runtime, PID, recent stderr) without interrupting
- `!startproject` wizard — creates new project with Claude Code template, agents, skills, commands, and optional git/GitHub setup
- `!cancel` command — cancel an active wizard mid-flow
- Generic wizard system for multi-step interactive commands
- Docker control — Claude has full Docker access inside the container (socket mounted)

## Architecture
```
Discord message → Discord.js bot (claude-api container) → Claude CLI → reply to Discord
```
- `claude-api/` container: Express server (port 3400) + Discord.js bot
- n8n removed (was unused — no Discord nodes in n8n 2.11.2)
- Claude CLI authenticates via mounted credentials from host
- Docker socket mounted + `group_add: ["989"]` gives Claude container management access

## What Was Done This Session

### New Features
- **`!btw` command** — Non-destructive progress peek while Claude is working. Shows runtime, PID, and last ~500 chars of stderr activity. Says "Nothing running" when idle.
- **`!processes` command** — Shows active Claude processes and resource usage across all channels
- **`!startproject` wizard** — Interactive project creation: asks for name, location, git setup (new private GitHub repo / existing / none). Copies full Claude Code project template with agents, commands, skills, and CLAUDE.md.
- **Sunday weekly preview** — Auto-sends at noon on Sundays with upcoming events, tasks, and goals. Also available on-demand via `!weekly`.
- **Generic wizard system** (`wizard.js`) — Reusable multi-step interaction engine with conditional steps, validation, and defaults. Powers `!startproject` and evening check-in.

### Project Template (`project-template/`)
- Generic `CLAUDE.md` and `NextSteps.md` with `{{PROJECT_NAME}}` placeholders
- 12 genericized agent definitions (product, engineering, design, QA, data science)
- 3 commands: `/reinit`, `/qa`, `/fix` (team-based QA and fix workflows)
- Verification skill: evidence-before-claims discipline

### Briefing Fixes
- **Embed suppression fixed** — Switched from `<>` URL wrapping to Discord's native `MessageFlags.SuppressEmbeds` flag
- **Evening check-in refactored** — Now uses wizard system instead of one-off `awaitingTasks` boolean

## Likely Next Steps

### 1. Test new features in Discord
- Run `!btw` while Claude is working — verify runtime and stderr output display
- Run `!processes` — verify it shows active Claude instances
- Run `!startproject` — test full wizard flow (name → location → git setup → template copy)
- Run `!weekly` — verify weekly preview content
- Test `!cancel` during a wizard

### 2. Evaluate n8n
- n8n container is running but unused — consider removing from `docker-compose.yml` to save resources

### 3. More personalities
- Add new personality files in `claude-api/personalities/`

### 4. Monitoring & reliability
- Add error alerting (post to a Discord channel when briefing fails)

## Key Files
| File | Purpose |
|------|---------|
| `claude-api/bot.js` | Discord bot — message handling, Claude CLI spawn, commands, wizard integration |
| `claude-api/wizard.js` | Generic multi-step wizard engine |
| `claude-api/wizards/startproject.js` | `!startproject` wizard definition |
| `claude-api/briefings.js` | Briefing system — data fetchers, prompt builder, scheduler, weekly preview |
| `claude-api/briefing-config.js` | Briefing config — tickers, weather, news topics, job search, schedules |
| `claude-api/tasks-storage.js` | Task persistence — save/load/clear tasks for briefing |
| `claude-api/project-template/` | Full Claude Code project template (CLAUDE.md, agents, commands, skills) |
| `claude-api/personalities/tiffany_pollard.md` | Main personality file |
| `claude-api/server.js` | Express server + bot startup |
| `claude-api/Dockerfile` | Node 20, Claude CLI, Docker CLI, copies all .js + wizards + template |
| `docker-compose.yml` | Services, networks, volumes, healthcheck, Docker socket mount |
| `.env` | Secrets (not committed) |
