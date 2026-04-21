---
name: reinit
description: Re-establish project context by reviewing NextSteps.md, current Signal routing, and runtime state for a new session
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(docker*), Bash(git*)
---

# Re-initialize Project Context

Read the following files and information to re-establish context for this session.

## 1. Handoff Document
Read `NextSteps.md` in the project root. This contains:
- What was built and the current architecture
- What's working and what's broken
- Specific next steps to pick up from

## 2. Key Source Files
Read these files to understand the current implementation:
- `claude-api/bot.js` — Signal runtime routing, commands, and CLI/SDK split
- `claude-api/server.js` — Express server, setup/OAuth flows, and internal endpoints
- `claude-api/adapters/signal.js` — Signal adapter and sidecar integration
- `claude-api/chat-responder.js` — non-owner Anthropic SDK fast-path
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
3. The current routing split: owner CLI vs non-owner SDK vs blocked escalation
4. Any obvious drift between `NextSteps.md` and `CLAUDE.md`
5. The recommended next action to take
6. Any blockers or questions to resolve first
