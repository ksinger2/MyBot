#!/bin/bash
# Send a Signal DM from Bianca to the owner (Karen).
# Usage: send-signal-dm.sh "message text"
# Called by mybot-heartbeat.ps1 after recovery to notify the owner.

MSG="$1"
if [ -z "$MSG" ]; then
  echo "Usage: send-signal-dm.sh <message>" >&2
  exit 1
fi

SIGNAL_CONTAINER="mybot-signal-api-1"
SIGNAL_URL="http://localhost:8080"
BOT_NUMBER="+15105191582"
OWNER_NUMBER="+16315214787"

# Wait up to 90s for signal-api to be healthy
for i in $(seq 1 18); do
  if docker exec "$SIGNAL_CONTAINER" curl -sf "$SIGNAL_URL/v1/about" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 18 ]; then
    echo "signal-api not reachable after 90s" >&2
    exit 1
  fi
  sleep 5
done

# Send DM via node inside claude-api (avoids JSON escaping issues with curl)
docker exec mybot-claude-api-1 node -e "
  const h = require('http');
  const d = JSON.stringify({
    message: process.argv[1],
    number: '$BOT_NUMBER',
    recipients: ['$OWNER_NUMBER']
  });
  const r = h.request({
    hostname: 'signal-api', port: 8080, path: '/v2/send', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }
  }, (s) => { process.exit(s.statusCode === 201 ? 0 : 1); });
  r.on('error', () => process.exit(1));
  r.write(d);
  r.end();
" "$MSG"
