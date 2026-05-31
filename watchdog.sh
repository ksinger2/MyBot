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

# ── Pre-check: Docker socket responsiveness (10s timeout) ──────────────
# If Docker is completely wedged (HCS_E_CONNECTION_TIMEOUT), even
# `docker info` hangs forever. Use a hard timeout to detect this.
if ! timeout 10 docker info >/dev/null 2>&1; then
    log "ERROR: Docker socket unresponsive (10s timeout) — signaling caller for wsl --shutdown"
    exit 2
fi

# Wait for Docker daemon (normal startup delay, up to 60s)
for i in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done

if ! docker info >/dev/null 2>&1; then
  log "ERROR: Docker daemon not running"
  exit 1
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

# Check if container is running and healthy
STATUS=$(docker inspect mybot-claude-api-1 --format '{{.State.Status}}' 2>/dev/null)
HEALTH=$(docker inspect mybot-claude-api-1 --format '{{.State.Health.Status}}' 2>/dev/null)

if [ "$STATUS" = "running" ] && [ "$HEALTH" != "unhealthy" ]; then
  exit 0
fi

log "Container not healthy (status=$STATUS health=$HEALTH) — attempting restart"

# Try a simple start/restart first
cd "$COMPOSE_DIR"
docker compose up -d 2>>"$LOG"
sleep 15

STATUS=$(docker inspect mybot-claude-api-1 --format '{{.State.Status}}' 2>/dev/null)
if [ "$STATUS" = "running" ]; then
  log "Container recovered with simple restart"
  exit 0
fi

# If that failed, prune and rebuild from scratch
log "Simple restart failed — pruning and rebuilding"
docker compose down 2>>"$LOG"
docker system prune -af 2>>"$LOG"
docker compose up -d --build 2>>"$LOG"
sleep 20

STATUS=$(docker inspect mybot-claude-api-1 --format '{{.State.Status}}' 2>/dev/null)
if [ "$STATUS" = "running" ]; then
  log "Container recovered after full rebuild"
  exit 0
else
  log "ERROR: Container still not running after rebuild"
  exit 1
fi
