/**
 * smoke-test.js — Post-startup health verification
 *
 * Runs automatically after startup to verify critical subsystems work.
 * Results are persisted and optionally sent to the owner via Signal.
 * If tests fail, the safe-rebuild snapshot is NOT taken.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { atomicWriteJsonSync } = require('./atomic-write');
// H2 (auth hardening): closure-backed token, not process.env
const { getInternalToken } = require('./internal-token');

const RESULTS_FILE = path.join('/app/data', 'smoke-test-results.json');
const MAX_RESULTS = 20;

function _httpPost(urlPath, body = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 3400,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': getInternalToken(),
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs || 15000,
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function _httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3400,
      path: urlPath,
      method: 'GET',
      timeout: 10000,
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Run the smoke test suite. Returns { passed, failed, results }.
 */
async function runSmokeTests() {
  const results = [];
  let passed = 0;
  let failed = 0;

  // Test 1: Health endpoint
  try {
    const res = await _httpGet('/health');
    if (res.status === 200 && res.body?.status === 'ok') {
      results.push({ test: 'health', status: 'pass' });
      passed++;
    } else {
      results.push({ test: 'health', status: 'fail', detail: `HTTP ${res.status}` });
      failed++;
    }
  } catch (err) {
    results.push({ test: 'health', status: 'fail', detail: err.message });
    failed++;
  }

  // Test 2: Image generation (only if OPENAI_API_KEY is set)
  // gpt-image-1 occasionally spikes past 4min — retry once on timeout before failing.
  if (process.env.OPENAI_API_KEY) {
    const attemptImagine = () => _httpPost('/imagine', { prompt: 'smoke test: solid blue square, 64x64 pixels' }, 360000);
    let res, err;
    try { res = await attemptImagine(); } catch (e) { err = e; }
    if (err && /timeout/i.test(err.message)) {
      err = null;
      try { res = await attemptImagine(); } catch (e) { err = e; }
    }
    if (err) {
      results.push({ test: 'imagine', status: 'fail', detail: err.message });
      failed++;
    } else if (res.status === 200 && res.body?.path && fs.existsSync(res.body.path)) {
      results.push({ test: 'imagine', status: 'pass' });
      passed++;
      try { fs.unlinkSync(res.body.path); } catch {}
    } else {
      results.push({ test: 'imagine', status: 'fail', detail: `HTTP ${res.status}: ${res.body?.error || 'no path'}` });
      failed++;
    }
  } else {
    results.push({ test: 'imagine', status: 'skip', detail: 'OPENAI_API_KEY not set' });
  }

  // Test 3: Signal adapter connected
  try {
    const { signalAdapter } = require('./bot');
    if (signalAdapter?.ready) {
      results.push({ test: 'signal', status: 'pass' });
      passed++;
    } else {
      results.push({ test: 'signal', status: 'fail', detail: 'adapter not ready' });
      failed++;
    }
  } catch (err) {
    results.push({ test: 'signal', status: 'fail', detail: err.message });
    failed++;
  }

  // Test 4: Image registry module loads
  try {
    const reg = require('./image-registry');
    if (typeof reg.setInput === 'function' && typeof reg.getOutputs === 'function') {
      results.push({ test: 'image-registry', status: 'pass' });
      passed++;
    } else {
      results.push({ test: 'image-registry', status: 'fail', detail: 'missing methods' });
      failed++;
    }
  } catch (err) {
    results.push({ test: 'image-registry', status: 'fail', detail: err.message });
    failed++;
  }

  // Test 5: Repair ledger module loads
  try {
    const ledger = require('./repair-ledger');
    if (typeof ledger.addAttempt === 'function') {
      results.push({ test: 'repair-ledger', status: 'pass' });
      passed++;
    } else {
      results.push({ test: 'repair-ledger', status: 'fail', detail: 'missing methods' });
      failed++;
    }
  } catch (err) {
    results.push({ test: 'repair-ledger', status: 'fail', detail: err.message });
    failed++;
  }

  const summary = { passed, failed, total: passed + failed, results, timestamp: new Date().toISOString() };

  // Persist results
  try {
    let history = [];
    try { history = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); } catch {}
    history.push(summary);
    while (history.length > MAX_RESULTS) history.shift();
    atomicWriteJsonSync(RESULTS_FILE, history);
  } catch {}

  return summary;
}

/**
 * Run smoke tests and report to Signal owner.
 * Called from startup after a delay.
 */
async function runAndReport() {
  console.log('[smoke-test] Running post-startup smoke tests...');
  const summary = await runSmokeTests();
  console.log(`[smoke-test] Results: ${summary.passed} passed, ${summary.failed} failed`);

  // Only alert when the SAME test fails 3 runs in a row (suppress transient OpenAI timeouts etc.)
  if (summary.failed > 0) {
    try {
      const history = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
      const prev1 = history[history.length - 2];
      const prev2 = history[history.length - 3];
      const failedIn = (run) => new Set((run?.results || []).filter(r => r.status === 'fail').map(r => r.test));
      const prev1Fails = failedIn(prev1);
      const prev2Fails = failedIn(prev2);
      const persistentFails = summary.results.filter(r => r.status === 'fail' && prev1Fails.has(r.test) && prev2Fails.has(r.test));
      if (persistentFails.length > 0) {
        const { SIGNAL_OWNER } = require('./project-permissions');
        const { signalAdapter } = require('./bot');
        if (SIGNAL_OWNER && signalAdapter?.ready) {
          const failList = persistentFails.map(r => `  - ${r.test}: ${r.detail}`).join('\n');
          await signalAdapter.sendMessage(SIGNAL_OWNER,
            `Smoke test FAILED twice in a row:\n${failList}`
          );
        }
      } else {
        console.log('[smoke-test] Transient failure suppressed (not consecutive)');
      }
    } catch {}
  }

  return summary;
}

/**
 * Get the latest smoke test results.
 */
function getLatest() {
  try {
    const history = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    return history[history.length - 1] || null;
  } catch { return null; }
}

module.exports = { runSmokeTests, runAndReport, getLatest };
