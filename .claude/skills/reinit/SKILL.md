---
name: reinit
description: Re-establish project context by reviewing NextStep.md, code, and Docker state for a new session
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(docker*), Bash(git*)
---

# Re-initialize Project Context

Read the following files and information to re-establish context for this session.

## 1. Handoff Document
Read `NextStep.md` in the project root. This contains:
- What was built and the current architecture
- What's working and what's broken
- Specific next steps to pick up from

## 2. Key Source Files
Read these files to understand the current implementation:
- `claude-api/bot.js` — Discord bot logic and Claude CLI integration
- `claude-api/server.js` — Express server that starts the bot
- `docker-compose.yml` — Service configuration
- `claude-api/Dockerfile` — Container build steps

## 3. Start Services
Start the Docker containers if they're not already running:
- Run `docker compose up -d` to start all services
- Run `docker compose ps` to confirm containers are running
- Run `docker compose logs claude-api --tail 20` to see recent activity
- Run `git log --oneline -10` to see recent commits
- Run `git status` to see uncommitted changes

## 4. Memory
Check the memory directory for any saved context:
- Read files in the Claude memory directory if they exist

## 5. Summarize
After reading everything, provide:
1. A brief summary of the project state
2. What's currently working vs broken
3. The recommended next action to take
4. Any blockers or questions to resolve first
