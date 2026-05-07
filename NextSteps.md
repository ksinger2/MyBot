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
- Cloudflare env vars wired into container AND CLI child process spawn env + deterministic system prompt hints
- Workspace audit (`!audit <minutes>`) — periodic cross-workspace bug finder; spawns parallel Claude sessions per sandbox project, checks builds/tests/security, auto-fixes issues, reports to owner DM
- Auto-resume after rebuild — interrupted tasks auto-retry via synthetic message dispatch (max 2 attempts, then falls back to notify); activeTask now stores senderId for correct dispatch context
- Security hardening (from Bianca's session): unlock rate limiting, owner output filter, encrypted group members, enhanced secret scrubbing (JSON patterns), path traversal containment
- Deterministic date/time injection, user timezone from profile, auto-context date ranges
- Sandbox users can DM Bianca without being on the Signal allowlist
- All container services healthy

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
- Daniel's app migration to daniel.backtoirl.com via Cloudflare Pages — in progress
- Many files still hardcode America/Los_Angeles (briefings, calendar-cli, rss-fetcher, media-pulse, schedules-storage)
- system-prompt.js still mentions America/Los_Angeles in the REMIND tag syntax line (low priority)

## Next Steps
<!-- Prioritized — what to pick up next -->
- Verify Daniel's Cloudflare deployment completes successfully
- Test `!audit now` end-to-end from owner DM
- Clean up remaining hardcoded America/Los_Angeles references in non-critical paths
