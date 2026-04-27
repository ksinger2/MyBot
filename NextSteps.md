# MyBot — Next Steps

## What's Working
- AI Pulse (5x/day) now uses pure RSS feeds — zero Claude sessions
- Media Pulse (3x/day) now uses pure RSS feeds — zero Claude sessions
- Morning Briefing now uses template formatting with email digest — zero Claude sessions
- Weekly Preview now uses template formatting — zero Claude sessions
- Email search CLI tool (`/app/email-search-cli.js`) for deterministic Gmail search
- Server-side `/email/search`, `/email/thread`, `/email/draft` endpoints
- Morning briefing includes email triage (important, needs-reply, unsubscribe categories)
- System prompt guides Claude to use CLI tool for email (avoids MCP search misses)
- Signal watchdog auto-restarts signal-api on health check failure
- Process leak prevention (session expiry, bg tasks, graceful shutdown)
- Security hardening (no hardcoded creds, XSS fixes, PII scrubbed from logs)

## What's Broken / In Progress
- Gmail MCP search can still miss emails — CLI tool is the primary fix, but MCP tools remain as backup
- Stale webhook detection was removed from signal-watchdog.js by linter — only HTTP health check remains

## Next Steps
- Monitor RSS feeds to verify they return content (some feeds may block or rate-limit)
- Verify email digest appears in morning briefing after rebuild
- Consider adding more RSS feeds if current ones don't provide enough coverage
- Test email-search-cli.js end-to-end after rebuild
