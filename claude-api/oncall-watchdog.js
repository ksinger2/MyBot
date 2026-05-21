'use strict';

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHECK_INTERVAL = 2 * 60 * 1000;
const HISTORY_SIZE = 10;

let _interval = null;
let _history = [];
let _running = false;
let _cliFailCount = 0;
let _cliLastResult = { ok: true, version: null, ts: 0 };
let _cliEscalatedAt = 0;
let _lagFailCount = 0;

function log(msg) {
  console.log(`[oncall-watchdog] ${msg}`);
}

function logWarn(msg) {
  console.warn(`[oncall-watchdog] ${msg}`);
}

// ── Escalation — always route through sendErrorAlert for 15-min dedup ──
async function escalate(title, detail) {
  const msg = `[ONCALL] ${title}\n${detail}`;
  log(`ESCALATING: ${msg}`);
  try {
    const { sendErrorAlert } = require('./error-alerting');
    sendErrorAlert(new Error(msg), { source: `oncall-${title}` });
  } catch {}
}

// ── Check 1: CLI Auth Health ──
async function checkCliAuth() {
  return new Promise((resolve) => {
    const child = execFile('claude', ['--version'], { timeout: 10000, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        _cliFailCount++;
        const result = { check: 'cli_auth', ok: false, error: err.message, consecutiveFailures: _cliFailCount };
        logWarn(`CLI health failed (${_cliFailCount}/3): ${err.message}`);
        const CLI_ESCALATE_COOLDOWN = 30 * 60 * 1000;
        if (_cliFailCount >= 3 && (Date.now() - _cliEscalatedAt) > CLI_ESCALATE_COOLDOWN) {
          _cliEscalatedAt = Date.now();
          escalate('CLI Auth Degraded', 'claude --version failed 3 consecutive times. Manual intervention may be needed.');
        }
        _cliLastResult = { ok: false, version: null, ts: Date.now() };
        resolve(result);
      } else {
        _cliFailCount = 0;
        const version = (stdout || '').trim();
        _cliLastResult = { ok: true, version, ts: Date.now() };
        resolve({ check: 'cli_auth', ok: true, version });
      }
    });
  });
}

// ── Check 2: Sandbox Credential Freshness ──
function checkSandboxCreds() {
  const result = { check: 'sandbox_creds', ok: true, refreshed: [] };
  try {
    const srcPath = '/home/node/.claude/.credentials.json';
    let srcMtime;
    try {
      srcMtime = fs.statSync(srcPath).mtimeMs;
    } catch {
      return { ...result, skipped: 'source credentials not found' };
    }

    const sandbox = require('./sandbox');
    const config = sandbox.listSandboxUsers();
    const seen = new Set();
    for (const entry of Object.values(config)) {
      if (!entry || !entry.linuxUser || entry.linuxUser.startsWith('_') || seen.has(entry.linuxUser)) continue;
      seen.add(entry.linuxUser);
      const dstPath = `/home/${entry.linuxUser}/.claude/.credentials.json`;
      try {
        const dstMtime = fs.statSync(dstPath).mtimeMs;
        if (srcMtime - dstMtime > 5 * 60 * 1000) {
          sandbox.refreshCredentials(entry.linuxUser);
          result.refreshed.push(entry.linuxUser);
          log(`Refreshed stale creds for ${entry.linuxUser} (${Math.round((srcMtime - dstMtime) / 1000)}s behind)`);
        }
      } catch {
        try {
          sandbox.refreshCredentials(entry.linuxUser);
          result.refreshed.push(entry.linuxUser);
          log(`Refreshed missing creds for ${entry.linuxUser}`);
        } catch (refreshErr) {
          logWarn(`Could not refresh creds for ${entry.linuxUser}: ${refreshErr.message}`);
        }
      }
    }
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  }
  return result;
}

// ── Check 3: Process Leak Detection ──
function checkProcessLeaks() {
  const result = { check: 'process_leaks', ok: true, claudeCount: 0, nodeCount: 0, killed: [] };
  try {
    const procDirs = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
    const claudeProcs = [];
    let nodeCount = 0;

    for (const dir of procDirs) {
      try {
        const cmdline = fs.readFileSync(`/proc/${dir}/cmdline`, 'utf8');
        const status = fs.readFileSync(`/proc/${dir}/status`, 'utf8');
        const uidMatch = status.match(/^Uid:\s*(\d+)/m);
        const uid = uidMatch ? parseInt(uidMatch[1], 10) : 0;
        // Sandbox users have uid >= 1000 and != node's uid (typically 1000)
        // We're looking for processes owned by sandbox users (uid > 1000)
        if (uid <= 1000) continue;

        if (cmdline.includes('claude') && !cmdline.includes('watchdog')) {
          claudeProcs.push({ pid: parseInt(dir, 10), startTime: fs.statSync(`/proc/${dir}`).ctimeMs });
        }
        if (cmdline.includes('node')) {
          nodeCount++;
        }
      } catch { /* process exited */ }
    }

    result.claudeCount = claudeProcs.length;
    result.nodeCount = nodeCount;

    if (claudeProcs.length > 10) {
      claudeProcs.sort((a, b) => a.startTime - b.startTime);
      const toKill = claudeProcs.slice(0, claudeProcs.length - 5);
      for (const p of toKill) {
        try {
          process.kill(p.pid, 'SIGTERM');
          result.killed.push(p.pid);
          log(`Killed leaked claude process pid=${p.pid}`);
        } catch {}
      }
      // SIGKILL stragglers after 5s
      if (toKill.length > 0) {
        setTimeout(() => {
          for (const p of toKill) {
            try { process.kill(p.pid, 0); process.kill(p.pid, 'SIGKILL'); } catch {}
          }
        }, 5000);
      }
    }

    if (nodeCount > 20) {
      result.ok = false;
      escalate('Process Leak: Node', `${nodeCount} node processes owned by sandbox users. Possible fork bomb or leak.`);
    }
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  }
  return result;
}

// ── Check 4: Disk Space ──
function checkDiskSpace() {
  const result = { check: 'disk_space', ok: true, partitions: {} };
  const checks = [
    { mount: '/app/data', threshold: 90 },
    { mount: '/tmp', threshold: 80 },
  ];

  for (const { mount, threshold } of checks) {
    try {
      const output = execFileSync('/usr/bin/df', ['--output=pcent', mount], { encoding: 'utf8', timeout: 5000 });
      const match = output.match(/(\d+)%/);
      if (!match) continue;
      const pct = parseInt(match[1], 10);
      result.partitions[mount] = pct;

      if (mount === '/tmp' && pct >= threshold) {
        log(`/tmp at ${pct}% — sweeping stale files`);
        sweepTmp();
      }
      if (mount === '/app/data' && pct >= threshold) {
        result.ok = false;
        escalate('Disk Space Critical', `/app/data at ${pct}% usage`);
      }
    } catch (err) {
      result.partitions[mount] = 'error';
    }
  }
  return result;
}

function sweepTmp() {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1h
  let removed = 0;
  try {
    for (const name of fs.readdirSync('/tmp')) {
      if (!name.startsWith('imagine_') && !name.startsWith('claude-')) continue;
      const full = path.join('/tmp', name);
      try {
        const st = fs.lstatSync(full);
        if (now - st.mtimeMs > maxAge) {
          if (st.isDirectory()) {
            fs.rmSync(full, { recursive: true, force: true });
          } else {
            fs.unlinkSync(full);
          }
          removed++;
        }
      } catch {}
    }
    if (removed > 0) log(`Swept ${removed} stale /tmp entries`);
  } catch {}
}

// ── Check 5: Docker Cleanup ──
let _lastDockerPruneAt = 0;
const DOCKER_PRUNE_INTERVAL = 6 * 60 * 60 * 1000; // every 6 hours
function checkDockerCleanup() {
  const result = { check: 'docker_cleanup', ok: true, pruned: false };
  if (Date.now() - _lastDockerPruneAt < DOCKER_PRUNE_INTERVAL) return result;
  if (!fs.existsSync('/var/run/docker.sock')) {
    _lastDockerPruneAt = Date.now() - DOCKER_PRUNE_INTERVAL + 60 * 60 * 1000;
    result.error = 'docker socket not available';
    return result;
  }
  try {
    const imgOut = execFileSync('docker', ['image', 'prune', '-f'], { encoding: 'utf8', timeout: 30000 });
    const sizeMatch = imgOut.match(/reclaimed\s+space:\s+(.+)/i);
    const buildOut = execFileSync('docker', ['builder', 'prune', '-f', '--filter', 'until=48h'], { encoding: 'utf8', timeout: 30000 });
    const buildMatch = buildOut.match(/reclaimed\s+space:\s+(.+)/i);
    const imgReclaimed = sizeMatch ? sizeMatch[1].trim() : '0B';
    const buildReclaimed = buildMatch ? buildMatch[1].trim() : '0B';
    if (imgReclaimed !== '0B' || buildReclaimed !== '0B') {
      log(`Docker pruned — images: ${imgReclaimed}, build cache: ${buildReclaimed}`);
      result.pruned = true;
    }
    _lastDockerPruneAt = Date.now();
  } catch (err) {
    // Back off 1 hour on failure instead of retrying every watchdog cycle
    _lastDockerPruneAt = Date.now() - DOCKER_PRUNE_INTERVAL + 60 * 60 * 1000;
    result.error = err.message;
  }
  return result;
}

// ── Check 6: Event Loop Lag ──
function checkEventLoopLag() {
  return new Promise((resolve) => {
    const start = Date.now();
    setTimeout(() => {
      const lag = Date.now() - start;
      const result = { check: 'event_loop_lag', ok: true, lagMs: lag };

      if (lag > 30000) {
        _lagFailCount++;
        if (_lagFailCount >= 3) {
          result.ok = false;
          result.action = 'graceful_restart';
          log(`Event loop lag ${lag}ms for 3 consecutive checks — triggering graceful restart`);
          escalate('Event Loop Lag Critical', `${lag}ms lag for 3 consecutive checks. Restarting.`).then(() => {
            // Drain in-flight requests before exiting
            try {
              const srv = require('./server').server;
              if (srv && srv.close) {
                srv.close(() => process.exit(1));
                setTimeout(() => process.exit(1), 10000).unref();
                return;
              }
            } catch {}
            setTimeout(() => process.exit(1), 2000);
          });
        } else {
          logWarn(`Event loop lag ${lag}ms (${_lagFailCount}/3)`);
        }
      } else if (lag > 5000) {
        logWarn(`Event loop lag elevated: ${lag}ms`);
        _lagFailCount = 0;
      } else {
        _lagFailCount = 0;
      }

      resolve(result);
    }, 0);
  });
}

// ── Check 6: Semaphore Leak Detection ──
function checkSemaphoreLeaks() {
  const result = { check: 'semaphore_leaks', ok: true, leaked: 0, cleaned: [] };
  try {
    const runner = require('./runner');
    // The runner exports _processRegistry indirectly through the process registry.
    // We can check active slots vs live processes by reading the registry.
    // The _processRegistry is a Map of pid -> info. Check if each pid is alive.
    // We don't have direct access to _processRegistry, but we can check the
    // channel states for stale activeTask flags.
    const bot = require('./bot');
    if (!bot.channels) return result;

    for (const [channelId, state] of bot.channels) {
      if (!state || !state.busy) continue;
      // If busy but no live process, it's a leaked semaphore
      const proc = state.process;
      let alive = false;
      if (proc && proc.pid) {
        try { process.kill(proc.pid, 0); alive = true; } catch {}
      }
      if (!alive && state.busy) {
        log(`Clearing leaked session in channel ${channelId} (no live process)`);
        state.busy = false;
        state.process = null;
        state.startedAt = null;
        try {
          const { freshProgress } = require('./runner');
          state.progress = freshProgress();
        } catch {}
        result.leaked++;
        result.cleaned.push(channelId);
      }
    }
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  }
  return result;
}

// ── Run all checks ──
async function runAllChecks() {
  if (_running) {
    logWarn('Previous check cycle still running — skipping');
    return _history.length > 0 ? _history[_history.length - 1] : null;
  }
  _running = true;
  try {
    const ts = Date.now();
    const results = {};
    const checks = [
      ['cli_auth', checkCliAuth],
      ['sandbox_creds', checkSandboxCreds],
      ['process_leaks', checkProcessLeaks],
      ['disk_space', checkDiskSpace],
      ['docker_cleanup', checkDockerCleanup],
      ['event_loop_lag', checkEventLoopLag],
      ['semaphore_leaks', checkSemaphoreLeaks],
    ];

    for (const [name, fn] of checks) {
      try {
        results[name] = await fn();
      } catch (err) {
        results[name] = { check: name, ok: false, error: err.message };
      }
    }

    const allOk = Object.values(results).every(r => r.ok !== false);
    const entry = { ts, ok: allOk, results };
    _history.push(entry);
    if (_history.length > HISTORY_SIZE) _history.shift();

    const failedChecks = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
    if (failedChecks.length > 0) {
      logWarn(`Degraded: ${failedChecks.join(', ')}`);
    }

    return entry;
  } finally {
    _running = false;
  }
}

// ── Public API ──

function getCliHealthCache() {
  return _cliLastResult;
}

function getHealthReport() {
  return {
    history: _history,
    current: _history.length > 0 ? _history[_history.length - 1] : null,
    running: _interval !== null,
  };
}

function startWatchdog() {
  if (_interval) return;
  log('Started (2min interval)');
  // Run first check after 30s to let the server stabilize
  setTimeout(() => {
    runAllChecks().catch(err => logWarn(`Check cycle error: ${err.message}`));
  }, 30000);
  _interval = setInterval(() => {
    runAllChecks().catch(err => logWarn(`Check cycle error: ${err.message}`));
  }, CHECK_INTERVAL);
  if (_interval.unref) _interval.unref();
}

function stopWatchdog() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    log('Stopped');
  }
}

module.exports = { startWatchdog, stopWatchdog, getHealthReport, getCliHealthCache, runAllChecks };
