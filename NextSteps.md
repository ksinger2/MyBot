# MyBot — Next Steps

## What's Working
<!-- Updated each session -->
- **Sandbox isolation**: Daniel (+16318487980) and Merrisa (+12068024303) each have isolated Docker-volume workspaces at `/sandbox/<Name>` with mount-namespace isolation hiding `/workspace` entirely. OS-enforced via `unshare --mount` + `runuser`, not prompt-based.
- **OAuth credential sharing**: All users (owner, non-owner, sandbox) authenticate via owner's OAuth. ANTHROPIC_API_KEY removed entirely. `.claude.json` (settings) and `.claude/.credentials.json` (OAuth token) are copied to all user homes at startup and provisioning.
- **Auto-context pre-fetching**: Calendar and weather queries detected server-side via regex, data pre-fetched and injected into prompt as `<calendar-data>`/`<weather-data>` tags. Claude formats what's already there — no tag emission needed.
- **Briefings**: Template-based (no AI), scheduled at 9 AM Pacific. Stocks, weather, calendar, tasks, RSS news, email digest, mindfulness. Timezone-correct: all date calculations use Pacific time, not UTC.
- **Signal adapter**: Webhook mode (`SIGNAL_USE_WEBHOOK=true`), JSON-RPC signal-api sidecar.
- **Tag stripping**: All action tags (`[LEARNED:]`, `[IMAGINE:]`, `[CALENDAR:]`, etc.) stripped during streaming so users never see raw tags.
- **Crash-loop recovery**: entrypoint.sh detects repeated crashes and restores last-known-good code from backup.

## What Was Fixed This Session
- **Briefing timezone bug**: Morning briefing for Thursday was showing Wednesday events. Root cause: `server.js /calendar/events` endpoint used UTC midnight as day boundaries instead of Pacific midnight. Fixed in three places:
  1. `briefings.js:fetchCalendar` — uses Pacific dates via `toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })`
  2. `briefings.js:formatCalendarToday` — removed fragile string-parsing; now displays exactly what the API returns since `fetchCalendar(1)` already requests the correct single day
  3. `server.js:/calendar/events` — `timeMin`/`timeMax` now convert Pacific midnight → UTC via offset calculation
- **Sandbox "not logged in"**: Sandbox users (Merrisa, Daniel) got "Not logged in" because provisioning only copied `.claude.json` (settings) but not `.claude/.credentials.json` (OAuth token). Fixed in `sandbox.js:provisionUser` and `entrypoint.sh`.
- **Sandbox "credit balance too low"**: runner.js was injecting `ANTHROPIC_API_KEY` for non-owner sessions, overriding OAuth. Removed all references to `ANTHROPIC_API_KEY` from runner.js, sdk-runner.js, and docker-compose.yml.
- **Auto-context determinism**: Calendar/weather queries no longer depend on Claude emitting `[CALENDAR:]`/`[WEATHER:]` tags. Data is pre-fetched server-side and injected into the prompt.

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
- **signal-api unhealthy**: `signal-api` container shows `unhealthy` status — may need restart or investigation
- **Picture handling**: User mentioned sending Bianca a picture — needs verification that image attachment handling works correctly

## Architecture Notes
- **Determinism Rule**: Never rely on prompt language alone to guarantee behavior. All critical behaviors enforced at infrastructure level (mount namespaces, file permissions, server-side tag handling, auto-context injection).
- **Sandbox spawn chain**: `sudo -E /usr/bin/unshare --mount -- /bin/sh -c 'mount -t tmpfs tmpfs /workspace && exec runuser -u <user> -- claude ...'`
- **Sudoers**: `node ALL=(root) NOPASSWD:SETENV: /usr/sbin/useradd, /usr/bin/chown, /usr/bin/mkdir, /usr/bin/cp, /usr/bin/unshare`
- **Docker capability**: `SYS_ADMIN` required for mount namespace isolation

## Next Steps
<!-- Prioritized — what to pick up next -->
1. Verify Merrisa and Daniel can now chat with Bianca without auth errors
2. Investigate signal-api unhealthy status
3. Verify picture/image attachment handling works
4. Consider adding OAuth token refresh to sandbox provisioning (tokens expire)
