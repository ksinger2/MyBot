'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const { atomicWriteJsonSync } = require('./atomic-write');

const WATCHDOG_STATE_FILE = '/app/data/watchdog-state.json';

let watchdogInterval = null;
let lastWebhookAt = 0;
let lastDataMessageAt = 0;
let startedAt = 0;
let consecutiveFailures = 0;
let lastRestartAt = 0;
let lastOwnerAlertAt = 0;

const HEALTH_CHECK_INTERVAL = 60_000;
const RESTART_COOLDOWN = 10 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const CONTAINER_NAME = 'mybot-signal-api-1';
// If HTTP is healthy but no webhook envelopes at all in 60 min, WebSocket is likely dead.
// Uses webhook activity (any envelope including receipts/read notifications), NOT text
// messages — 30+ minutes of no texts is normal, but no envelopes at all means dead.
const STALE_WEBSOCKET_MS = 60 * 60_000;

function _readState() {
  try { return JSON.parse(fs.readFileSync(WATCHDOG_STATE_FILE, 'utf-8')); } catch { return {}; }
}

function _writeState(patch) {
  try { atomicWriteJsonSync(WATCHDOG_STATE_FILE, { ..._readState(), ...patch }); } catch (e) {
    console.error('[signal-watchdog] Failed to persist state:', e.message);
  }
}

function recordWebhookActivity() {
  lastWebhookAt = Date.now();
}

function recordDataMessage() {
  lastDataMessageAt = Date.now();
}

function getLastWebhookTimestamp() {
  if (lastWebhookAt > 0) return lastWebhookAt;
  const s = _readState();
  return s.lastWebhookAt || 0;
}

function log(msg) {
  console.log(`[signal-watchdog] ${msg}`);
}

async function checkHealth(apiUrl) {
  try {
    const res = await fetch(`${apiUrl}/v1/about`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function restartContainer(signalAdapter, ownerChatId, reason) {
  const now = Date.now();
  if (now - lastRestartAt < RESTART_COOLDOWN) {
    log('Restart skipped — cooldown active');
    return;
  }
  lastRestartAt = now;
  consecutiveFailures = 0;

  log(`Restarting ${CONTAINER_NAME} — ${reason}`);
  execFile('docker', ['restart', CONTAINER_NAME], (err, stdout, stderr) => {
    if (err) {
      log(`Restart failed: ${err.message}`);
      return;
    }
    log('Restart succeeded');

    lastWebhookAt = Date.now();
    lastDataMessageAt = Date.now();
    // No owner notification — bridge restarts are not user-actionable.
    // Check !health or docker logs for bridge status.
  });
}

function startSignalWatchdog(signalAdapter, ownerChatId) {
  if (watchdogInterval) return;

  startedAt = Date.now();
  lastWebhookAt = Date.now();
  lastDataMessageAt = Date.now();
  consecutiveFailures = 0;
  log('Started');

  const apiUrl = (signalAdapter && signalAdapter.apiUrl) || 'http://signal-api:8080';

  watchdogInterval = setInterval(async () => {
    const healthy = await checkHealth(apiUrl);

    if (healthy) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      log(`Health check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    }

    if (lastWebhookAt > 0) _writeState({ lastWebhookAt, lastDataMessageAt });

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      restartContainer(signalAdapter, ownerChatId, 'HTTP unresponsive');
      return;
    }

    // WebSocket death detection: HTTP is healthy but no webhook envelopes at all
    // (receipts, read notifications, typing indicators, or text messages).
    // 30+ minutes of no TEXT messages is totally normal — but no envelopes at all
    // means the WebSocket is genuinely dead.
    if (healthy && lastWebhookAt > 0) {
      const staleness = Date.now() - lastWebhookAt;
      const uptime = Date.now() - startedAt;
      if (uptime > 10 * 60_000 && staleness > STALE_WEBSOCKET_MS) {
        log(`No webhook envelopes in ${Math.round(staleness / 60_000)}min — WebSocket likely dead`);
        restartContainer(signalAdapter, ownerChatId, 'no webhook envelopes in 60min');
      }
    }
  }, HEALTH_CHECK_INTERVAL);
  if (watchdogInterval.unref) watchdogInterval.unref();
}

function stopSignalWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    log('Stopped');
  }
}

module.exports = { startSignalWatchdog, stopSignalWatchdog, recordWebhookActivity, recordDataMessage, getLastWebhookTimestamp };
