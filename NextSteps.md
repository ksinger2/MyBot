# MyBot — Next Steps

## What's Working
<!-- Updated each session -->
- Deterministic date/time injection — every message gets server-computed date/time prepended, even on session resume
- User timezone from profile — each user's IANA timezone (stored in their profile) is used instead of hardcoded America/Los_Angeles
- Auto-context date ranges (calendar "tomorrow", "this week") use user's profile timezone
- Reminder hints inject user's timezone instead of hardcoded LA
- Sandbox users can DM Bianca without being on the Signal allowlist
- All 150 tests passing, container healthy

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
- Many other files still hardcode America/Los_Angeles (briefings, calendar-cli, rss-fetcher, media-pulse, schedules-storage) — not user-facing for date display but worth cleaning up
- system-prompt.js still mentions America/Los_Angeles in the REMIND tag syntax line (low priority — auto-context hint overrides it)

## Next Steps
<!-- Prioritized — what to pick up next -->
- Verify date correctness by sending Bianca a date-sensitive question
- Clean up remaining hardcoded America/Los_Angeles references in non-critical paths
