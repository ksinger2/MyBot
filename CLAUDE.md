# MyBot — Signal Assistant Runtime

## Overview
Signal-first assistant runtime that routes owner conversations to Claude Code CLI with OAuth-backed tooling and routes non-owner conversational traffic through the Anthropic SDK fast-path. The codebase also handles scheduling, briefings, calendar flows, reminders, media/news digests, and Signal-specific onboarding and routing.

## Tech Stack
- Node.js runtime with Signal adapter(s)
- Claude Code CLI (spawned as child process with `--output-format stream-json`)
- Anthropic SDK for low-cost non-owner conversational flows and digest formatting
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
| `claude-api/bot.js` | Main Signal runtime — routing, commands, CLI/SDK split, progress tracking |
| `claude-api/server.js` | Express server — internal endpoints, setup/OAuth flows, and webhook support |
| `claude-api/adapters/signal.js` | Signal adapter and sidecar integration |
| `claude-api/chat-responder.js` | Non-owner Anthropic SDK fast-path |
| `claude-api/monitor-config.js` | Monitor config CRUD — JSON persistence for polling monitors |
| `claude-api/pollers.js` | Poller functions — GitHub CI (`gh` CLI) and URL health checks |
| `claude-api/monitor-runner.js` | Timer-based polling loop — dedup, dispatch, rate limiting |
| `claude-api/personalities/` | Personality files that define voice/style |
| `claude-api/project-template/` | Template files for `!startproject` (CLAUDE.md, NextSteps.md, agents) |
| `docker-compose.yml` | Container config, env vars, volume mounts |

## Conventions
- Brevity first for normal Signal chat; owner/operator mode can be longer when needed
- Auto-rebuild after code changes — don't tell the user to rebuild, just do it
- Non-owner chats should stay on the SDK fast-path unless they truly need escalation
- System prompt is assembled in `askClaude()` from: brevity rules + capabilities + identity + personality file
- Three-layer timeout: stall (10min), check-in (5min), hard cap (90min)

## Determinism Rule (CRITICAL)
**Never rely on prompt language alone to guarantee behavior.** Any time a plan depends on Claude reliably including something in a tool call (a parameter, a flag, a value), that is non-deterministic and WILL fail.

When designing a feature, always ask: *"What happens if Claude omits this?"* If the answer is "it breaks," make it deterministic at the infrastructure level instead:
- Store context server-side (e.g., `image-context.js`) and auto-inject it in the handler
- Use middleware or wrappers that enforce required values regardless of Claude's output
- Collect data that gets stripped/consumed during streaming (e.g., `strippedImagePaths`) so it isn't lost
- Prompt instructions are UI polish only — not a reliability mechanism

Examples of non-deterministic (BAD) vs deterministic (GOOD):
- ❌ "You MUST pass inputImagePath in the curl call" → Claude sometimes forgets it
- ✅ `imageContext.set(path)` before session + `imageContext.consume()` in `/imagine` handler
- ❌ "Include the file path in your response" → path gets stripped during streaming
- ✅ Collect stripped paths in proxy, send as attachments after session ends
