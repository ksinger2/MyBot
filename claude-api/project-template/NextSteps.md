# {{PROJECT_NAME}} — Session Handoff

<!--
PURPOSE: This file is the handoff document between Claude Code sessions.
Every time you end a work session, update this file so the next session
can pick up exactly where you left off. Think of it as a note to your
future self (or a future agent).

HOW TO UPDATE:
- Summarize what was built or changed this session
- Note what's working and what's broken
- List specific next steps with enough detail to act on immediately
- Include any blockers, open questions, or decisions needed
- Keep it concise — bullet points, not essays
- Use /reinit at the start of each new session to read this file + project context

WHEN TO UPDATE:
- At the end of every work session
- After completing a significant feature or fix
- When you hit a blocker and need to context-switch
- Before handing off to another person or agent
-->

## What's Working
- Three-layer timeout system replacing flat 30min hard kill:
  - **Stall detector** (10 min no output) — kills only truly stalled sessions, resets on every stdout AND stderr data event
  - **Progress check-ins** (every 5 min) — sends elapsed time, turn count, and current tool to Discord automatically
  - **Hard cap** (90 min) — absolute maximum runtime safety net
- Long-running agent loops can now run up to 90 min as long as they're producing output
- Stderr activity (warnings, progress, tool use) now correctly resets the stall timer — no more false stall kills
- `!btw` — detailed progress: live-streamed Claude text (e.g. "Now let me commit and push"), tool history, other Claude CLI sessions with PID + working directory
- `!imagine <prompt>` — generates images via OpenAI `gpt-image-1`, shows the exact API payload before sending, then posts the image
- Bot ignores messages from all Discord bot accounts (`message.author.bot` guard)
- Full capabilities injected into system prompt — Claude knows it can generate images, browse the web, use Docker, git, sub-agents, and work across projects
- Internal `/imagine` HTTP endpoint at `localhost:3400/imagine` so Claude CLI can generate images via curl

## What's Broken / In Progress
- N/A

## Next Steps
1. Monitor stall detector in production — tune STALL_TIMEOUT (10 min) if it's too aggressive or too lenient
2. Consider making check-in interval configurable per channel or via a command
3. Consider adding a warning message before the hard cap kills (e.g., at 80 min)
4. Consider higher quality / larger sizes for `!imagine` (currently `quality: 'low'`, `1024x1024`)

## Architecture
- `bot.js` constants: `MAX_TIMEOUT` (90 min hard cap), `STALL_TIMEOUT` (10 min), `CHECKIN_INTERVAL` (5 min)
- `askClaude()` now accepts `discordChannel` param for sending check-in messages
- `freshProgress()` includes `lastActivity` timestamp + `recentOutputs` array (last 15 lines of Claude's text + tool completions), updated on every stdout AND stderr data event
- Text deltas captured line-by-line as they stream in (not just at block end)
- Other Claude sessions detected via `/proc/<pid>/cwd` for directory info
- Stall check runs every 30s via `setInterval`, cleared on process close
- `openai` npm package used for `!imagine` and `/imagine` endpoint (gpt-image-1, base64 response)
- System prompt lists all 7 capability areas so Claude never claims it can't do something it can

## Key Files
| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project-level conventions — capabilities reference for Claude sessions |
| `NextSteps.md` | This file — session handoff document |
| `bot.js` | Main bot logic — timeout/stall/check-in/imagine/system prompt |
| `server.js` | Express server — `/ask`, `/imagine`, `/health` endpoints |
