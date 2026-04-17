# MyBot — Next Steps

## What's Working
- All token optimization changes committed (583b398)
- Rebuild loop prevention committed (d45960c)
- Discord deactivated via .env
- Owner Signal DM → Claude Code parity mode (Opus 4.7, no turn limit, no kill timeouts, stderr surfaced, liveness pings at 15/45/90m). Gated on `ownerDmMode = senderIsOwner && !isGroupChat`. Non-owner/group paths unchanged.
- `!mode plan` / `!mode auto` toggle (owner DM only):
  - `!mode` shows current, `!mode plan` switches to read-only (Read, Grep, Glob, LS, WebSearch, WebFetch, TodoWrite, Task — no Edit/Write/Bash), `!mode auto` restores full tools
  - State persists per-chat via `state.codingMode` in channel state
  - Plan-mode preamble in `system-prompt.js` tells Claude to research + propose + wait for `!mode auto`
  - Command file: `claude-api/commands/mode.js`; runtime wiring threads `planMode` through bot.js → Runner → runner.js args + system prompt

## What's Broken / In Progress
- Nothing broken

## Next Steps
- Rebuild to deploy: token cuts, 75-turn limit, debounce reduction, Discord off (already deployed as of last rebuild)
- Optional: copy host's `~/.claude/mcp.json` servers (Figma, Chrome DevTools, Gmail, Google Calendar, Supabase, Amplitude, Canva) into `claude-api/.mcp.json` for full MCP parity with Claude Code on host. Currently only Playwright is configured. Most need OAuth/secrets mounted.
