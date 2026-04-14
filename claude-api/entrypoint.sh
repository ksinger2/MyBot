#!/bin/bash
# Entrypoint wrapper — PM2 lifecycle, crash loop detection, last-known-good restore

CRASH_LOG="/home/node/.claude/.crash-timestamps"
BACKUP_DIR="/home/node/.claude/.last-known-good-bot"
MAX_CRASHES=3
CRASH_WINDOW=120
ROLLED_BACK_MARKER="/tmp/.rolled-back"

# PM2 persistence — store PM2 state in mounted volume so it survives rebuilds
export PM2_HOME="/home/node/.claude/.pm2"
mkdir -p "$PM2_HOME"

count_recent_crashes() {
  [ ! -f "$CRASH_LOG" ] && echo 0 && return
  local now count=0
  now=$(date +%s)
  while IFS= read -r ts; do
    [ -n "$ts" ] && [ $((now - ts)) -lt $CRASH_WINDOW ] && count=$((count + 1))
  done < "$CRASH_LOG"
  echo "$count"
}

# If crash-looping and backup exists, restore it
RECENT=$(count_recent_crashes)
if [ "$RECENT" -ge "$MAX_CRASHES" ] && [ -d "$BACKUP_DIR" ]; then
  echo "[ENTRYPOINT] Crash loop detected ($RECENT crashes in ${CRASH_WINDOW}s). Restoring last-known-good code..."
  cp "$BACKUP_DIR"/*.js /app/ 2>/dev/null
  cp -r "$BACKUP_DIR"/wizards /app/wizards 2>/dev/null
  cp -r "$BACKUP_DIR"/personalities /app/personalities 2>/dev/null
  cp -r "$BACKUP_DIR"/project-template /app/project-template 2>/dev/null
  : > "$CRASH_LOG"
  touch "$ROLLED_BACK_MARKER"
  echo "[ENTRYPOINT] Restored. Starting with last-known-good code."
fi

# Start PM2 daemon and resurrect any saved processes from previous lifecycle
pm2 resurrect 2>/dev/null || true
pm2 ping >/dev/null 2>&1 || true

# Trap signals to dump PM2 state before exit
cleanup() {
  echo "[ENTRYPOINT] Shutting down — dumping PM2 state..."
  # Write clean-shutdown marker so next boot doesn't send a false crash notification
  echo "$(date +%s)" > /home/node/.claude/.clean-shutdown
  # Relay signal to node so bot.js gracefulShutdown() can persist state
  [ -n "$NODE_PID" ] && kill -TERM "$NODE_PID" 2>/dev/null && wait "$NODE_PID" 2>/dev/null
  pm2 dump 2>/dev/null
  pm2 kill 2>/dev/null
  exit 0
}
trap cleanup SIGTERM SIGINT

# Run the app in background so bash can process SIGTERM via trap
node server.js &
NODE_PID=$!
wait $NODE_PID
EXIT_CODE=$?

# On crash, record timestamp and dump PM2 state
pm2 dump 2>/dev/null
if [ $EXIT_CODE -ne 0 ]; then
  echo "[ENTRYPOINT] server.js exited with code $EXIT_CODE"
  date +%s >> "$CRASH_LOG"
fi

exit $EXIT_CODE
