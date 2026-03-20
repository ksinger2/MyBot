# MyBot — Claude Code Discord Bot

## Overview
Discord bot that wraps Claude Code CLI, giving users a chat interface to an autonomous coding agent. Users talk to a configurable personality who can build software, browse the web, generate images, and manage infrastructure — all from Discord.

## Tech Stack
- Node.js + Discord.js 14
- Claude Code CLI (spawned as child process with `--output-format stream-json`)
- OpenAI SDK (image generation via gpt-image-1)
- Express server for internal API endpoints
- Docker (single container, `restart: unless-stopped`)

## How to Run
```bash
docker compose up -d --build
```

## Key Files
| File | Purpose |
|------|---------|
| `claude-api/bot.js` | Main bot — Discord commands, Claude CLI wrapper, system prompt, progress tracking |
| `claude-api/server.js` | Express server — `/ask`, `/imagine`, `/health` endpoints |
| `claude-api/personalities/` | Personality files that define voice/style |
| `claude-api/project-template/` | Template files for `!startproject` (CLAUDE.md, NextSteps.md, agents) |
| `docker-compose.yml` | Container config, env vars, volume mounts |

## Bot Capabilities (injected into system prompt)
These are the capabilities Claude has when running inside the bot. The system prompt in `bot.js` tells Claude about all of them:

1. **Image Generation** — `curl -s -X POST http://localhost:3400/imagine` with a JSON prompt. Returns a file path to include in the response.
2. **Web Browsing** — Headless Chromium via Playwright MCP tools. Can navigate, screenshot, click, fill forms, extract content. Also has WebSearch/WebFetch.
3. **Code & Files** — Full read/write/edit/search/shell access. Autonomous software engineering.
4. **Docker** — Can run `docker ps`, `docker compose up -d --build`, restart containers, etc.
5. **Git & GitHub** — Commit, push, branch, PR, CI status — full workflow via `gh` CLI.
6. **Sub-Agents** — Can spawn focused sub-agents for parallel research or complex tasks.
7. **Multi-Project** — Workspace at `/workspace/` contains all projects. Can `cd` between them.

## Discord Commands
**Control:** `!stop`, `!clear`, `!kill`, `!killall`, `!restart`, `!status`, `!btw`, `!processes`
**Workspace:** `!cd`, `!ls`, `!startproject`
**Identity:** `!name`, `!identity`, `!personality`, `!personalities`
**Tasks:** `!tasks`, `!done`
**Scheduling:** `!schedule`, `!schedules`, `!unschedule`
**Briefing:** `!briefing`, `!weekly`
**Other:** `!email`, `!imagine`, `!help`

## Conventions
- Brevity first — Discord messages must be short (2-4 sentences simple, 6-8 complex)
- Auto-rebuild after code changes — don't tell the user to rebuild, just do it
- Image file paths MUST appear in text response for Discord attachment
- System prompt is assembled in `askClaude()` from: brevity rules + capabilities + identity + personality file
- Three-layer timeout: stall (10min), check-in (5min), hard cap (90min)
