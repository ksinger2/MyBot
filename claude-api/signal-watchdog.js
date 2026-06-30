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

let _lastPersistedAt = 0;
const PERSIST_THROTTLE_MS = 5 * 60_000; // write to disk at most every 5 min

function recordWebhookActivity() {
  lastWebhookAt = Date.now();
  if (staleRestartCount > 0) {
    log(`Webhook activity resumed after ${staleRestartCount} restart(s)`);
    staleRestartCount = 0;
    _writeState({ staleRestartCount: 0 });
  }
  // Throttled disk persist so restarts see a fresh timestamp
  if (lastWebhookAt - _lastPersistedAt > PERSIST_THROTTLE_MS) {
    _lastPersistedAt = lastWebhookAt;
    _writeState({ lastWebhookAt, lastDataMessageAt });
  }
}

function flushTimestamp() {
  if (lastWebhookAt > 0) _writeState({ lastWebhookAt, lastDataMessageAt });
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
  // Use the container-internal mount path, NOT HOST_PROJECT_PATH (which is a
  // host filesystem path that doesn't exist inside this container — execFile
  // throws ENOENT on a missing cwd, which previously cascaded into rm -f
  // permanently deleting signal-api with no way to recreate it).
  const composeDir = '/workspace/MyBot';
  log(`Force-recreating ${CONTAINER_NAME} via compose (cwd=${composeDir})`);
  execFile('docker', ['compose', '--profile', 'signal', 'up', '-d', '--force-recreate', 'signal-api'], {
    cwd: composeDir,
    timeout: 120_000,
  }, (err) => {
    if (err) {
      log(`Compose force-recreate failed: ${err.message} — will retry on next cycle`);
      // Do NOT rm -f — removing the container with no way to recreate it from
      // inside makes recovery impossible. External watchdog.sh handles this.
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
  _writeState({ staleRestartCount });

  // Cap restarts for stale WebSocket at 3. Beyond that, the WebSocket is
  // likely fine — just nobody texting. Without this cap, quiet periods
  // (no inbound messages for hours) trigger infinite restart+alert loops.
  // HTTP-failure restarts are uncapped since those indicate a real problem.
  if (reason !== 'HTTP unresponsive' && staleRestartCount > 3) {
    log(`Stale-restart cap reached (${staleRestartCount}) — suppressing further restarts until webhook activity or HTTP failure`);
    return;
  }

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
  lastWebhookAt = 0;
  lastDataMessageAt = 0;
  consecutiveFailures = 0;
  const savedState = _readState();
  staleRestartCount = savedState.staleRestartCount || 0;
  log(`Started (staleRestartCount restored: ${staleRestartCount})`);

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

    if (healthy) {
      const uptime = Date.now() - startedAt;
      if (uptime > STALE_WEBSOCKET_MS) {
        if (lastWebhookAt === 0) {
          log(`No webhook envelopes received since startup (${Math.round(uptime / 60_000)}min) — WebSocket likely dead`);
          restartContainer(signalAdapter, ownerChatId, 'no webhook envelopes since startup');
        } else {
          const staleness = Date.now() - lastWebhookAt;
          if (staleness > STALE_WEBSOCKET_MS) {
            log(`No webhook envelopes in ${Math.round(staleness / 60_000)}min — WebSocket likely dead`);
            restartContainer(signalAdapter, ownerChatId, 'no webhook envelopes in 60min');
          }
        }
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

module.exports = { startSignalWatchdog, stopSignalWatchdog, recordWebhookActivity, recordDataMessage, getLastWebhookTimestamp, flushTimestamp };
