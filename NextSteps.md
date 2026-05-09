# MyBot — Next Steps

## What's Working
<!-- Updated each session -->
- On-call watchdog (`oncall-watchdog.js`) running every 2min with 6 deterministic health checks:
  1. CLI auth health (escalates after 3 failures, 30min cooldown)
  2. Sandbox credential freshness (auto-refreshes if >5min stale)
  3. Process leak detection (kills orphan claude processes >10, escalates node >20)
  4. Disk space monitoring (/tmp sweep at 80%, escalate /app/data at 90%)
  5. Event loop lag (graceful restart after 3 consecutive >30s readings)
  6. Semaphore leak detection (clears stuck busy channels with dead processes)
- `/health/watchdog` endpoint returns rolling health report (last 10 cycles)
- `/health` endpoint now uses watchdog's cached CLI result (no redundant spawns)
- Sandbox auth hardening: 3-layer defense (per-spawn refresh + 60s periodic + auth-failure retry)
- All sandbox users (Merrisa, Daniel, Lee) have fresh creds and are ready

## What's Broken / In Progress
<!-- Active issues, blockers, half-done work -->
- Nothing actively broken. Monitoring for any remaining "Not logged in" errors in group chats.

## Next Steps
- Smoke test group chats with Merrisa/Daniel to confirm auth hardening works end-to-end
- Monitor watchdog logs for any degraded checks: `docker compose logs claude-api | grep oncall-watchdog`
