# MyBot — Next Steps

## What's Working
<!-- Updated each session -->
- Token auto-refresh — CLI OAuth token kept warm via 30-min heartbeat (`token-refresh.js`), eliminates "logged out" errors
- Sandbox group linking — `!sandbox link <phone>` gives a group chat full sandbox tools, session persistence, and shared cwd for co-development
- `!btw` works in sandbox-linked groups (still suppressed in social groups)
- Process-aware stall detector — checks if child process is alive; sandbox/owner sessions warn-only (never killed), social groups still get killed on threshold
- SessionId flush is now immediate (`critical: true`) — survives stall kills and container restarts
- `--effort medium` for non-owner chats caps thinking depth; owner DM gets `--effort high`
- Auto-continue enabled for sandbox group chats (was previously disabled for all groups)
- Cloudflare API token + account ID wired into container env for deployment across workspaces
- Security hardening (from Bianca's session): unlock rate limiting, owner output filter, encrypted group members, enhanced secret scrubbing (JSON patterns), path traversal containment
- Deterministic date/time injection, user timezone from profile, auto-context date ranges
- Sandbox users can DM Bianca without being on the Signal allowlist
- All container services healthy

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
- Bianca's partial fixes in bot.js (+160 lines) include security hardening, graceful shutdown improvements, and coding mode enhancements — committed but not individually tested
- Many files still hardcode America/Los_Angeles (briefings, calendar-cli, rss-fetcher, media-pulse, schedules-storage)
- system-prompt.js still mentions America/Los_Angeles in the REMIND tag syntax line (low priority)

## Next Steps
<!-- Prioritized — what to pick up next -->
- Test sandbox group chat end-to-end: send Daniel a message in the linked group, verify session persists across messages, verify `!btw` works
- Daniel + Karen co-dev: migrate Daniel's localhost work to daniel.backtoirl.com via Cloudflare
- Clean up remaining hardcoded America/Los_Angeles references in non-critical paths
