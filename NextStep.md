# MyBot — Session Handoff (2026-03-11)

## What Was Built
A Discord bot (**BiancaDaCow**) that uses Claude Code CLI (via Claude subscription, not API) to respond to messages. The bot runs in Docker.

## Architecture
```
Discord message → Discord.js bot (claude-api container) → Claude CLI → reply to Discord
```

- `claude-api/` container: Express.js server (port 3400) + Discord.js bot in a single Node.js process
- n8n container: present but **unused** — n8n 2.11.2 has no built-in Discord nodes, so we pivoted to Discord.js directly
- Both services connected via `bot-network` Docker bridge network
- Claude CLI authenticates via mounted credentials file from host (`~/.claude/.credentials.json`)

## Current State (as of end of session)

### Working
- Docker containers are up and healthy (`docker compose ps` shows both running)
- Bot logs into Discord as **BiancaDaCow#3914**
- Bot is connected to **Bianca's Server** (ID: 1481350577471361145)
- Bot receives messages and shows typing indicator
- Claude CLI works when tested directly: `docker exec mybot-claude-api-1 sh -c 'env HOME=/home/node claude -p "say hello" ...'` returns a valid response
- Discord privileged intents (Presence, Server Members, Message Content) are all enabled

### Not Working — Needs Debugging
- **Bot replies "Sorry, I could not generate a response."** — Claude CLI exits with code 1 when spawned from bot.js, but stderr is empty
- Last test: bot received "hey girly", Claude CLI ran for ~90s then failed
- stdout logging on error was added but hasn't been tested yet (latest build includes this fix)
- The credentials file is mounted read-only (`:ro`) — Claude CLI may need write access to refresh the OAuth token

## Likely Next Steps

### 1. Debug Claude CLI failure from bot.js
- Restart containers: `docker compose restart claude-api`
- Send a test message in Discord
- Check logs: `docker compose logs claude-api --tail 30`
- The stdout-on-error logging should now reveal the actual error
- If it's a permissions issue with the credentials file, change `:ro` to `:rw` in docker-compose.yml

### 2. If token refresh is the issue
- Change the volume mount in `docker-compose.yml` from:
  `${HOME}/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro`
  to:
  `${HOME}/.claude:/home/node/.claude`
- This lets Claude CLI write back refreshed tokens
- But be careful: the container runs as `node` user, may need directory ownership

### 3. If Claude CLI works but response parsing fails
- Check if `--output-format json` returns valid JSON
- The bot parses `parsed.result || parsed.text || stdout.trim()` — verify which field the CLI actually returns
- Test manually: `docker exec mybot-claude-api-1 sh -c 'env HOME=/home/node claude -p "hello" --output-format json --dangerously-skip-permissions --no-session-persistence'`

### 4. Cleanup (after bot works)
- Remove debug logging from `bot.js` (the `console.log` for every message)
- Consider removing n8n from `docker-compose.yml` if not needed for other workflows
- Delete or archive `n8n-workflows/discord-claude-bot.json` (uses non-existent n8n Discord nodes)

## Key Files
| File | Purpose |
|------|---------|
| `claude-api/bot.js` | Discord.js bot — message handling + Claude CLI spawn |
| `claude-api/server.js` | Express server (health + /ask endpoint) + starts bot |
| `claude-api/Dockerfile` | Node 20, installs Claude CLI globally, runs as `node` user |
| `claude-api/package.json` | Dependencies: express, discord.js |
| `docker-compose.yml` | Services: n8n + claude-api, networks, volumes, healthcheck |
| `.env` | Secrets: DISCORD_BOT_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, n8n config |
| `.env.example` | Template for .env |

## Environment Notes
- Discord Developer Portal: Bot has all privileged intents enabled, no verification needed (<100 servers)
- Claude auth: Uses subscription OAuth token, not API key. Token stored in `~/.claude/.credentials.json` on host
- Docker: WSL2 on Windows, containers access host filesystem via /mnt/c/
- Bot invite URL: `https://discord.com/oauth2/authorize?client_id=1481338044500938785&permissions=274877975552&scope=bot`
