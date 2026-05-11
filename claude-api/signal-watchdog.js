'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const { atomicWriteJsonSync } = require('./atomic-write');

const WATCHDOG_STATE_FILE = '/app/data/watchdog-state.json';

let watchdogInterval = null;
let lastWebhookAt = 0;
let startedAt = 0;
let consecutiveFailures = 0;
let lastRestartAt = 0;

const HEALTH_CHECK_INTERVAL = 60_000;
const RESTART_COOLDOWN = 10 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const CONTAINER_NAME = 'mybot-signal-api-1';

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

function restartContainer(signalAdapter, ownerChatId) {
  const now = Date.now();
  if (now - lastRestartAt < RESTART_COOLDOWN) {
    log('Restart skipped — cooldown active');
    return;
  }
  lastRestartAt = now;
  consecutiveFailures = 0;

  log(`Restarting ${CONTAINER_NAME}`);
  execFile('docker', ['restart', CONTAINER_NAME], (err, stdout, stderr) => {
    if (err) {
      log(`Restart failed: ${err.message}`);
      return;
    }
    log('Restart succeeded');

    // Reset webhook tracking so we don't immediately re-trigger
    lastWebhookAt = Date.now();

    if (signalAdapter && ownerChatId) {
      setTimeout(() => {
        signalAdapter.sendMessage(
          ownerChatId,
          'Signal connection was stale — I restarted the signal bridge. Messages should flow again in ~30s.'
        ).catch(e => log(`Failed to alert owner: ${e.message}`));
      }, 35000);
    }
  });
}

function startSignalWatchdog(signalAdapter, ownerChatId) {
  if (watchdogInterval) return;

  startedAt = Date.now();
  lastWebhookAt = Date.now();
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

    // Persist lastWebhookAt every tick so startup can detect gaps
    if (lastWebhookAt > 0) _writeState({ lastWebhookAt });

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log('Signal-api HTTP unresponsive — triggering restart');
      restartContainer(signalAdapter, ownerChatId);
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

module.exports = { startSignalWatchdog, stopSignalWatchdog, recordWebhookActivity, getLastWebhookTimestamp };
