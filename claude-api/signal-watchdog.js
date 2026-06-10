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
let staleRestartCount = 0;

const HEALTH_CHECK_INTERVAL = 60_000;
const RESTART_COOLDOWN = 10 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const CONTAINER_NAME = 'mybot-signal-api-1';
const STALE_WEBSOCKET_MS = 60 * 60_000;
// After this many simple restarts fail to restore webhooks, escalate to force-recreate
const ESCALATE_AFTER_RESTARTS = 2;
// After force-recreate also fails, alert owner
const ALERT_AFTER_RESTARTS = 3;
const OWNER_ALERT_COOLDOWN = 60 * 60_000;
let lastOwnerAlertAt = 0;

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
  if (staleRestartCount > 0) {
    log(`Webhook activity resumed after ${staleRestartCount} restart(s)`);
    staleRestartCount = 0;
  }
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

function _alertOwner(message) {
  const now = Date.now();
  if (now - lastOwnerAlertAt < OWNER_ALERT_COOLDOWN) return;
  lastOwnerAlertAt = now;
  try {
    const { sendErrorAlert } = require('./error-alerting');
    sendErrorAlert(message, { source: 'signal-watchdog' });
  } catch (e) {
    log(`Owner alert failed: ${e.message}`);
  }
}

function _forceRecreateContainer() {
  const composeDir = process.env.HOST_PROJECT_PATH || '/workspace/MyBot';
  log(`Force-recreating ${CONTAINER_NAME} via compose (cwd=${composeDir})`);
  execFile('docker', ['compose', 'up', '-d', '--force-recreate', 'signal-api'], {
    cwd: composeDir,
  }, (err) => {
    if (err) {
      log(`Compose force-recreate failed: ${err.message} — falling back to rm+start`);
      execFile('docker', ['rm', '-f', CONTAINER_NAME], (rmErr) => {
        if (rmErr) { log(`rm -f failed: ${rmErr.message}`); return; }
        log('Container removed — external watchdog will recreate it');
      });
    } else {
      log('Force-recreate succeeded');
    }
  });
}

function restartContainer(signalAdapter, ownerChatId, reason) {
  const now = Date.now();
  if (now - lastRestartAt < RESTART_COOLDOWN) {
    log('Restart skipped — cooldown active');
    return;
  }
  lastRestartAt = now;
  consecutiveFailures = 0;
  staleRestartCount++;

  if (staleRestartCount >= ALERT_AFTER_RESTARTS) {
    _alertOwner(`Signal bridge dead — ${staleRestartCount} restart attempts failed to restore webhook flow. Bot cannot receive messages.`);
  }

  if (staleRestartCount > ESCALATE_AFTER_RESTARTS) {
    log(`${staleRestartCount} restarts failed — escalating to force-recreate`);
    _forceRecreateContainer();
    return;
  }

  log(`Restarting ${CONTAINER_NAME} — ${reason} (attempt ${staleRestartCount})`);
  execFile('docker', ['restart', CONTAINER_NAME], (err) => {
    if (err) {
      log(`Restart failed: ${err.message}`);
      return;
    }
    log('Restart succeeded');
    // Do NOT reset lastWebhookAt — wait for a real webhook to arrive.
    // recordWebhookActivity() will clear staleRestartCount when one does.
  });
}

function startSignalWatchdog(signalAdapter, ownerChatId) {
  if (watchdogInterval) return;

  startedAt = Date.now();
  lastWebhookAt = Date.now();
  lastDataMessageAt = Date.now();
  consecutiveFailures = 0;
  staleRestartCount = 0;
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
