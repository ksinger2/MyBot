#!/bin/bash
# Entrypoint wrapper — detects crash loops and restores last-known-good code

CRASH_LOG="/home/node/.claude/.crash-timestamps"
BACKUP_DIR="/home/node/.claude/.last-known-good-bot"
MAX_CRASHES=3
CRASH_WINDOW=120
ROLLED_BACK_MARKER="/tmp/.rolled-back"

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

# Run the app
node server.js
EXIT_CODE=$?

# On crash, record timestamp
if [ $EXIT_CODE -ne 0 ]; then
  echo "[ENTRYPOINT] server.js exited with code $EXIT_CODE"
  date +%s >> "$CRASH_LOG"
fi

exit $EXIT_CODE
