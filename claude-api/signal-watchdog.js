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
let staleRestartCount = 0;

// Separate cooldown timers for HTTP vs stale-WebSocket paths
let lastHttpRestartAt = 0;
let lastStaleRestartAt = 0;

const HEALTH_CHECK_INTERVAL = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const CONTAINER_NAME = 'mybot-signal-api-1';
// A quiet chat legitimately produces zero inbound envelopes, so envelope silence
// is NOT proof the receive path is dead. Use a generous window (90min) so ordinary
// quiet periods (overnight, low traffic) never trip a restart. Genuine daemon
// receive-thread death is still caught, just a bit later.
const STALE_WEBSOCKET_MS = 90 * 60_000;

// Tier 1 (simple restart): 10min cooldown
const STALE_COOLDOWN_TIER1 = 10 * 60_000;
// Tier 2 (force-recreate): 30min cooldown
const STALE_COOLDOWN_TIER2 = 30 * 60_000;
// Tier 3 (suppressed, hourly alert only): 60min cooldown
const STALE_COOLDOWN_TIER3 = 60 * 60_000;
// HTTP restart: 10min cooldown, independent of stale timer
const HTTP_RESTART_COOLDOWN = 10 * 60_000;
// Time-based decay: reset staleRestartCount after 2h of no new triggers
const DECAY_THRESHOLD_MS = 2 * 60 * 60_000;

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
const PERSIST_THROTTLE_MS = 5 * 60_000;

function recordWebhookActivity() {
  lastWebhookAt = Date.now();
  if (staleRestartCount > 0) {
    log(`Webhook activity resumed after ${staleRestartCount} restart(s)`);
    staleRestartCount = 0;
    _writeState({ staleRestartCount: 0 });
  }
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

function getSignalWsStatus() {
  const now = Date.now();
  let state = 'active';
  if (staleRestartCount >= 6) {
    state = 'dead';
  } else if (staleRestartCount > 0) {
    state = 'stale';
  } else if (lastWebhookAt > 0 && (now - lastWebhookAt) > STALE_WEBSOCKET_MS) {
    state = 'stale';
  } else if (lastWebhookAt === 0 && startedAt > 0 && (now - startedAt) > STALE_WEBSOCKET_MS) {
    state = 'stale';
  }
  return { state, lastSeenAt: lastWebhookAt || null, restartCount: staleRestartCount };
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
  const composeDir = '/workspace/MyBot';
  log(`Force-recreating ${CONTAINER_NAME} via compose (cwd=${composeDir})`);
  execFile('docker', ['compose', '--profile', 'signal', 'up', '-d', '--force-recreate', 'signal-api'], {
    cwd: composeDir,
    timeout: 120_000,
  }, (err) => {
    if (err) {
      log(`Compose force-recreate failed: ${err.message} — will retry on next cycle`);
    } else {
      log('Force-recreate succeeded');
    }
  });
}

function restartContainer(signalAdapter, ownerChatId, reason) {
  const now = Date.now();
  const isHttpFailure = (reason === 'HTTP unresponsive');

  // HTTP failures use their own independent cooldown — never blocked by stale timer
  if (isHttpFailure) {
    if (now - lastHttpRestartAt < HTTP_RESTART_COOLDOWN) {
      log('HTTP restart skipped — cooldown active');
      return;
    }
    lastHttpRestartAt = now;
    consecutiveFailures = 0;
    log(`Restarting ${CONTAINER_NAME} — ${reason}`);
    execFile('docker', ['restart', CONTAINER_NAME], (err) => {
      if (err) log(`Restart failed: ${err.message}`);
      else log('Restart succeeded');
    });
    return;
  }

  // Stale WebSocket path — check cooldown BEFORE incrementing (crash-safety)
  const nextCount = staleRestartCount + 1;
  // Tier 1→2 boundary uses Tier 2's 30min cooldown: gives the last simple restart
  // more time to take effect before escalating to force-recreate
  const cooldown = nextCount <= 2 ? STALE_COOLDOWN_TIER1
                 : nextCount <= 5 ? STALE_COOLDOWN_TIER2
                 : STALE_COOLDOWN_TIER3;
  if (now - lastStaleRestartAt < cooldown) {
    log(`Stale restart skipped — cooldown active (tier ${nextCount <= 2 ? 1 : 2})`);
    return;
  }

  // Passed cooldown — commit the increment. Persist BOTH the count and the
  // timestamp: persisting the count alone let a restarted bot see lastStaleRestartAt=0
  // and bypass the cooldown, firing an immediate escalated force-recreate on boot.
  staleRestartCount = nextCount;
  lastStaleRestartAt = now;
  _writeState({ staleRestartCount, lastStaleRestartAt });

  // Unified tier decision block
  if (staleRestartCount <= 2) {
    // Tier 1: simple restart
    log(`Restarting ${CONTAINER_NAME} — ${reason} (tier 1, attempt ${staleRestartCount})`);
    execFile('docker', ['restart', CONTAINER_NAME], (err) => {
      if (err) log(`Restart failed: ${err.message}`);
      else log('Restart succeeded');
    });
  } else if (staleRestartCount <= 5) {
    // Tier 2: force-recreate
    log(`Force-recreating ${CONTAINER_NAME} — ${reason} (tier 2, attempt ${staleRestartCount})`);
    _alertOwner(`Signal WebSocket dead — escalating to force-recreate (attempt ${staleRestartCount}).`);
    _forceRecreateContainer();
  } else {
    // Tier 3: suppressed — alert owner hourly via _alertOwner's internal 60-min cooldown
    log(`Stale-restart suppressed (${staleRestartCount} attempts) — alerting owner`);
    _alertOwner(`Signal WebSocket dead — ${staleRestartCount} restart attempts exhausted. External intervention needed. Bot cannot receive messages.`);
  }
}

function startSignalWatchdog(signalAdapter, ownerChatId) {
  if (watchdogInterval) return;

  startedAt = Date.now();
  const savedState = _readState();
  // Seed lastWebhookAt from persisted state (or "now" on a fresh install) rather
  // than 0. Starting at 0 made a freshly-booted bot look "dead" after the stale
  // window even in a normal quiet period. Seeding to a real timestamp measures
  // staleness from the last KNOWN activity and gives a just-started bot a full
  // window before any judgment.
  lastWebhookAt = savedState.lastWebhookAt || startedAt;
  lastDataMessageAt = savedState.lastDataMessageAt || 0;
  consecutiveFailures = 0;
  staleRestartCount = savedState.staleRestartCount || 0;
  // Restore the cooldown timestamp too so cooldowns and the 2h decay survive a
  // process restart (see restartContainer for why persisting the count alone is a bug).
  lastStaleRestartAt = savedState.lastStaleRestartAt || 0;
  log(`Started (staleRestartCount restored: ${staleRestartCount}, lastStaleRestartAt: ${lastStaleRestartAt || 'none'})`);

  const apiUrl = (signalAdapter && signalAdapter.apiUrl) || 'http://signal-api:8080';

  watchdogInterval = setInterval(async () => {
    const now = Date.now();
    const healthy = await checkHealth(apiUrl);

    if (healthy) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      log(`Health check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    }

    if (lastWebhookAt > 0) _writeState({ lastWebhookAt, lastDataMessageAt });

    // Time-based decay: if 2h elapsed since last restart with no new staleness
    // triggers, reset counter. Handles legitimate quiet periods (nobody texting).
    if (staleRestartCount > 0 && lastStaleRestartAt > 0) {
      if ((now - lastStaleRestartAt) > DECAY_THRESHOLD_MS) {
        log(`Resetting staleRestartCount (was ${staleRestartCount}) — 2h elapsed with no new triggers`);
        staleRestartCount = 0;
        _writeState({ staleRestartCount: 0 });
      }
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      restartContainer(signalAdapter, ownerChatId, 'HTTP unresponsive');
      return;
    }

    if (healthy) {
      // Restart on envelope-silence only when BOTH: the bot has been up longer than
      // the stale window (don't judge a bot that just booted into a quiet period),
      // AND the last known envelope is older than the stale window. lastWebhookAt is
      // seeded to boot time, so this also covers "nothing since startup". This is a
      // conservative, last-resort recovery for a genuinely dead daemon receive thread;
      // the tier system + cooldowns + 2h decay keep it from looping on false positives.
      const staleness = now - lastWebhookAt;
      if ((now - startedAt) > STALE_WEBSOCKET_MS && staleness > STALE_WEBSOCKET_MS) {
        log(`No inbound envelopes in ${Math.round(staleness / 60_000)}min — receive path may be dead`);
        restartContainer(signalAdapter, ownerChatId, 'no webhook envelopes');
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

module.exports = { startSignalWatchdog, stopSignalWatchdog, recordWebhookActivity, recordDataMessage, getLastWebhookTimestamp, flushTimestamp, getSignalWsStatus };
