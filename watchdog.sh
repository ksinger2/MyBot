#!/bin/bash
# MyBot watchdog — ensures the container is running, rebuilds if needed
# Called by cron and by wsl-autostart.bat on boot
#
# Exit codes:
#   0 = container is running (or was recovered)
#   1 = recovery failed (normal failure)
#   2 = Docker socket unresponsive — caller should wsl --shutdown

COMPOSE_DIR="/mnt/c/Users/karen/Desktop/Github Projects/MyBot"
LOG="/tmp/mybot-watchdog.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

# Keep log from growing forever
tail -200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"

# ── Run lock: cron and wsl-autostart.bat can both invoke this. Two concurrent
# runs hitting the down/prune/rebuild block would corrupt compose state. ──────
exec 9>/tmp/mybot-watchdog.lock
if ! flock -n 9; then
    log "Another watchdog run in progress — skipping"
    exit 0
fi

# ── Pre-check: Docker socket responsiveness ────────────────────────────
# If Docker is genuinely wedged (HCS_E_CONNECTION_TIMEOUT), `docker info` hangs.
# But `docker info` is ALSO just slow under load or right after WSL wake, and a
# single slow call must NOT trigger the destructive `wsl --shutdown` path (that
# caused the death spiral: shutdown -> cold boot -> even slower -> shutdown again).
# Require several consecutive long-timeout failures before signaling exit 2.
DOCKER_OK=0
for attempt in 1 2 3; do
  if timeout 20 docker info >/dev/null 2>&1; then
    DOCKER_OK=1
    break
  fi
  log "docker info slow/unresponsive (attempt ${attempt}/3, 20s timeout)"
  sleep 5
done
if [ "$DOCKER_OK" -ne 1 ]; then
  log "ERROR: Docker socket unresponsive after 3x20s attempts — signaling caller for wsl --shutdown"
  exit 2
fi

# ── Disk space monitoring ─────────────────────────────────────────────
# Check WSL root filesystem usage
WSL_DISK_PERCENT=$(df / 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
if [ -n "$WSL_DISK_PERCENT" ] && [ "$WSL_DISK_PERCENT" -gt 80 ]; then
    log "WARNING: WSL root filesystem is ${WSL_DISK_PERCENT}% full — pruning Docker"
    docker system prune -af --filter "until=72h" 2>>"$LOG"
fi

# Check C: drive free space from WSL side
C_FREE_KB=$(df /mnt/c 2>/dev/null | tail -1 | awk '{print $4}')
if [ -n "$C_FREE_KB" ] && [ "$C_FREE_KB" -lt 5242880 ]; then
    log "WARNING: C: drive has less than 5 GB free (${C_FREE_KB} KB)"
fi

# Prune dangling images on every run (safe, only removes untagged)
docker image prune -f >/dev/null 2>&1

# ── Signal-api temp cleanup (prevents 150GB+ libsignal leak) ─────
# signal-cli's JVM extracts a 143MB native lib to /tmp on each restart
# and never cleans up. With tmpfs in docker-compose this is less critical,
# but clean up anyway in case tmpfs wasn't configured.
SIGNAL_TMP_COUNT=$(docker exec mybot-signal-api-1 bash -c 'ls -d /tmp/libsignal* 2>/dev/null | wc -l' 2>/dev/null)
if [ -n "$SIGNAL_TMP_COUNT" ] && [ "$SIGNAL_TMP_COUNT" -gt 5 ]; then
    docker exec mybot-signal-api-1 bash -c 'ls -dt /tmp/libsignal* | tail -n +3 | xargs rm -rf' 2>/dev/null
    log "Cleaned $((SIGNAL_TMP_COUNT - 2)) stale libsignal temp dirs from signal-api"
fi

# ── Signal-api container check (defense in depth) ───────────────────
# The internal signal-watchdog.js monitors from inside claude-api, but if
# it fails (wrong cwd, docker socket issues, claude-api itself restarting)
# this external check catches a missing/dead signal-api container.
SIGNAL_STATUS=$(docker inspect mybot-signal-api-1 --format '{{.State.Status}}' 2>/dev/null)
if [ "$SIGNAL_STATUS" != "running" ]; then
  log "signal-api not running (status=${SIGNAL_STATUS:-missing}) — bringing it up"
  cd "$COMPOSE_DIR"
  docker compose --profile signal up -d signal-api 2>>"$LOG"
  sleep 10
  SIGNAL_STATUS=$(docker inspect mybot-signal-api-1 --format '{{.State.Status}}' 2>/dev/null)
  if [ "$SIGNAL_STATUS" = "running" ]; then
    log "signal-api recovered"
  else
    log "WARNING: signal-api still not running after compose up"
  fi
fi

# Check if claude-api container is running and healthy
STATUS=$(docker inspect mybot-claude-api-1 --format '{{.State.Status}}' 2>/dev/null)
HEALTH=$(docker inspect mybot-claude-api-1 --format '{{.State.Health.Status}}' 2>/dev/null)

if [ "$STATUS" = "running" ] && [ "$HEALTH" != "unhealthy" ]; then
  exit 0
fi

log "Container not healthy (status=$STATUS health=$HEALTH) — attempting restart"

# Try a simple start/restart first
cd "$COMPOSE_DIR"
docker compose --profile signal up -d 2>>"$LOG"
sleep 15

STATUS=$(docker inspect mybot-claude-api-1 --format '{{.State.Status}}' 2>/dev/null)
if [ "$STATUS" = "running" ]; then
  log "Container recovered with simple restart"
  exit 0
fi

# If that failed, rebuild IN PLACE. Critically, do NOT `down` + `prune -af` first:
# that deletes the last-good image, so a failed build leaves nothing to fall back to
# and the bot is permanently down (this was the "self-repair breaks forever" path).
# `up -d --build` keeps the running image until the new one builds successfully.
log "Simple restart failed — rebuilding in place (last-good image preserved)"
docker compose --profile signal up -d --build 2>>"$LOG"
sleep 20

STATUS=$(docker inspect mybot-claude-api-1 --format '{{.State.Status}}' 2>/dev/null)
if [ "$STATUS" = "running" ]; then
  log "Container recovered after rebuild"
  # Only now, with a confirmed-good container, reclaim space from old dangling images.
  docker image prune -f >/dev/null 2>&1
  exit 0
else
  log "ERROR: Container still not running after rebuild — leaving last-good image intact for next cycle"
  exit 1
fi
