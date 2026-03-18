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
  - **Stall detector** (10 min no output) — kills only truly stalled sessions, resets on every stdout data event
  - **Progress check-ins** (every 5 min) — sends elapsed time, turn count, and current tool to Discord automatically
  - **Hard cap** (90 min) — absolute maximum runtime safety net
- Long-running agent loops can now run up to 90 min as long as they're producing output
- `!btw` command still works for on-demand progress checks

## What's Broken / In Progress
- N/A

## Next Steps
1. Monitor stall detector in production — tune STALL_TIMEOUT (10 min) if it's too aggressive or too lenient
2. Consider making check-in interval configurable per channel or via a command
3. Consider adding a warning message before the hard cap kills (e.g., at 80 min)

## Architecture
- `bot.js` constants: `MAX_TIMEOUT` (90 min hard cap), `STALL_TIMEOUT` (10 min), `CHECKIN_INTERVAL` (5 min)
- `askClaude()` now accepts `discordChannel` param for sending check-in messages
- `freshProgress()` includes `lastActivity` timestamp, updated on every stdout data event
- Stall check runs every 30s via `setInterval`, cleared on process close

## Key Files
| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project conventions and setup instructions |
| `NextSteps.md` | This file — session handoff document |
| `bot.js` | Main bot logic — timeout/stall/check-in system lives here |
