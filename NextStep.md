# MyBot — Session Handoff (2026-03-12)

## What's Working
- Discord bot (**BiancaDaCow**) is live and responding in Discord
- Claude Code CLI integration working (subscription-based, not API)
- Per-channel session persistence, identity/personality switching
- Morning briefing system (scheduled 9am PT daily + `!briefing` on-demand)
- Briefing modules: stocks (with portfolio tracking), weather, news, jobs, mindfulness
- Bot commands: `!stop`, `!clear`, `!kill`, `!cd`, `!ls`, `!personality`, `!briefing`, etc.

## Architecture
```
Discord message → Discord.js bot (claude-api container) → Claude CLI → reply to Discord
```
- `claude-api/` container: Express server (port 3400) + Discord.js bot
- n8n container: present but unused (no Discord nodes in n8n 2.11.2)
- Claude CLI authenticates via mounted credentials from host

## What Was Done This Session

### Briefing Fixes
- **Fixed `error_max_turns`** — `maxTurns` changed from 1 → 15 so Claude can web search + respond
- **News section overhauled** — now searches 5 specific topics with timeframes (Iran conflict last 12hrs, tech acquisitions last 2 days, Anthropic news last 3 days, etc.), requires source links for every item
- **Jobs section overhauled** — now searches for real PM postings from last 7 days across AI companies, big tech, media, and hot startups with apply links
- **Brevity enforced** — briefing prompt caps output to ~3 Discord messages, scannable format

### Bot-Wide Changes
- **Global brevity rule** — injected as first line of system prompt for ALL bot responses: short, bullet points, easy to skim
- **Personality fix** — Bianca no longer calls herself "New York"; personality file uses `[your name]` placeholder

## Likely Next Steps

### 1. Test & tune the briefing
- Run `!briefing` and check: Are stocks showing? Are news links real? Are job postings current?
- If stocks still missing, check `docker compose logs claude-api` for yahoo-finance2 errors
- If Claude still writes too much, tighten the brevity instructions or add a character limit
- If `error_max_turns` returns, bump maxTurns above 15

### 2. ~~Fix briefing section bleed & job seniority~~ FIXED
- Mindfulness section now strictly wellness only — explicitly blocks news/AI/tech/links
- Jobs section now requires Senior/Staff/Director/VP/Head level only — explicitly skips APM, Associate, junior, entry-level, mid-level

### 3. Evaluate n8n
- n8n container is running but unused — consider removing from `docker-compose.yml` to save resources
- Or find a use case (scheduled workflows, integrations beyond Discord)

### 3. More personalities
- Add new personality files in `claude-api/personalities/`
- Switch with `!personality <name>` in Discord

### 4. Monitoring & reliability
- Add error alerting (post to a Discord channel when briefing fails)
- Log briefing output/cost over time
- Consider health checks for the Claude CLI credential refresh

## Key Files
| File | Purpose |
|------|---------|
| `claude-api/bot.js` | Discord bot — message handling, Claude CLI spawn, brevity rule |
| `claude-api/briefings.js` | Briefing system — data fetchers, prompt builder, scheduler |
| `claude-api/briefing-config.js` | Briefing config — tickers, weather, news topics, job search |
| `claude-api/personalities/tiffany_pollard.md` | Main personality file |
| `claude-api/server.js` | Express server + bot startup |
| `claude-api/Dockerfile` | Node 20, Claude CLI, runs as `node` user |
| `docker-compose.yml` | Services, networks, volumes, healthcheck |
| `.env` | Secrets (not committed) |
