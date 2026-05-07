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
- Cloudflare env vars ($CLOUDFLARE_API_TOKEN, $CLOUDFLARE_ACCOUNT_ID) wired into container AND CLI child process spawn env + deterministic system prompt hints
- Cloudflare API token updated to correct format (was `cfk_...` which is invalid; replaced with proper API Token from dashboard)
- Security hardening (from Bianca's session): unlock rate limiting, owner output filter, encrypted group members, enhanced secret scrubbing (JSON patterns), path traversal containment
- Deterministic date/time injection, user timezone from profile, auto-context date ranges
- Sandbox users can DM Bianca without being on the Signal allowlist
- All container services healthy

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
- Bianca's partial fixes in bot.js (+160 lines) include security hardening, graceful shutdown improvements, and coding mode enhancements — committed but not individually tested
- Many files still hardcode America/Los_Angeles (briefings, calendar-cli, rss-fetcher, media-pulse, schedules-storage)
- system-prompt.js still mentions America/Los_Angeles in the REMIND tag syntax line (low priority)
- Daniel's app migration to daniel.backtoirl.com via Cloudflare Pages — in progress, Bianca deploying with corrected token

## Next Steps
<!-- Prioritized — what to pick up next -->
- Verify Bianca successfully deploys Daniel's app to daniel.backtoirl.com with the corrected Cloudflare token
- Clean up remaining hardcoded America/Los_Angeles references in non-critical paths
