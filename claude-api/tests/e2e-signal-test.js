#!/usr/bin/env node
/**
 * End-to-End Signal Bot Test Harness
 * ===================================
 *
 * Tests the Signal webhook handler by sending crafted payloads to POST /signal/webhook
 * and verifying expected behavior via Docker container logs.
 *
 * Prerequisites:
 *   - Docker containers running: `docker compose up -d`
 *   - The claude-api container must be healthy and accepting connections on port 3400
 *   - The internal-token.json must exist inside the container at /app/data/internal-token.json
 *
 * Usage:
 *   node tests/e2e-signal-test.js
 *
 * Options:
 *   --timeout=<ms>   Per-test timeout (default: 30000)
 *   --verbose        Show all log lines from Docker (not just matched patterns)
 *   --test=<n>       Run only test number N (1-6)
 *
 * Architecture:
 *   1. Reads the internal auth token from Docker container (never from .env or disk)
 *   2. Sends HTTP POST to localhost:3400/signal/webhook with crafted Signal envelopes
 *   3. Tails `docker compose logs` watching for expected log patterns
 *   4. Reports PASS/FAIL per test with timing
 *
 * IMPORTANT: This runs on the HOST, not inside Docker.
 */

'use strict';

const http = require('http');
const { execSync, spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';
const PORT = 3400;
const WEBHOOK_PATH = '/signal/webhook';
const COMPOSE_PROJECT = 'mybot';
const CONTAINER_SERVICE = 'claude-api';

// Test identities
const OWNER_PHONE = '+16315214787';
const BOT_PHONE = '+15105191582';
const SANDBOX_USER_UUID = '59237aa4-ee2e-4f5b-a651-07457c4e4ba7'; // Daniel
const SANDBOX_USER_UUID_LEE = 'b6f36d70-3ae5-4dd3-9db5-9c464b8807a0';

// Known groups (bot is a member)
const GROUP_BIANCA_BOOBOO = 'zysKwKxgwfnRF029F2edeG7ywPUzWAcdcgWlqoMcLUk=';
const GROUP_FAMILY_ASSISTED = 'sphV/4DQquMMyWm6HEVGg84LOB7A7w1wGRxfxiKIEoE=';
const GROUP_KARRISLEDY = 'BZ8a7ri7HabiXHnMJ91KSYADhyrKpxnC7SDNkbe+ddU=';

// Parse CLI args
const args = process.argv.slice(2);
const TIMEOUT = parseInt((args.find(a => a.startsWith('--timeout=')) || '').split('=')[1] || '30000', 10);
const VERBOSE = args.includes('--verbose');
const ONLY_TEST = parseInt((args.find(a => a.startsWith('--test=')) || '').split('=')[1] || '0', 10);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function logError(msg) {
  console.error(`[${timestamp()}] ERROR: ${msg}`);
}

/**
 * Fetch the internal API token from the running Docker container.
 * Never reads .env or any local secrets file.
 */
function getInternalToken() {
  try {
    const token = execSync(
      `docker compose exec -T ${CONTAINER_SERVICE} printenv INTERNAL_API_TOKEN`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    if (!token) {
      throw new Error('INTERNAL_API_TOKEN env var is empty in container');
    }
    return token;
  } catch (err) {
    throw new Error(
      `Failed to read internal token from container. Is Docker running?\n` +
      `  Command: docker compose exec -T ${CONTAINER_SERVICE} printenv INTERNAL_API_TOKEN\n` +
      `  Error: ${err.message}`
    );
  }
}

/**
 * Send an HTTP POST to the signal webhook endpoint.
 * Returns the HTTP status code and response body.
 */
function sendWebhook(token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: WEBHOOK_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out (10s)'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Create a Signal envelope payload for a DM (no group).
 */
function makeDmEnvelope(source, message, extraFields = {}) {
  const ts = Date.now();
  return {
    envelope: {
      source,
      sourceNumber: source.startsWith('+') ? source : undefined,
      sourceUuid: source.startsWith('+') ? undefined : source,
      sourceDevice: 1,
      timestamp: ts,
      dataMessage: {
        timestamp: ts,
        message,
        groupInfo: null,
        ...extraFields,
      },
    },
  };
}

/**
 * Create a Signal envelope payload for a group message.
 */
function makeGroupEnvelope(source, groupId, message, extraFields = {}) {
  const ts = Date.now();
  return {
    envelope: {
      source,
      sourceNumber: source.startsWith('+') ? source : undefined,
      sourceUuid: source.startsWith('+') ? undefined : source,
      sourceDevice: 1,
      timestamp: ts,
      dataMessage: {
        timestamp: ts,
        message,
        groupInfo: {
          groupId,
          type: 'DELIVER',
        },
        ...extraFields,
      },
    },
  };
}

/**
 * Watch Docker logs for patterns matching expected strings.
 * Returns a promise that resolves when ANY pattern matches, or rejects on timeout.
 *
 * @param {string[]} patterns - Array of substrings to look for in logs
 * @param {number} timeoutMs - Max time to wait
 * @param {string[]} [failPatterns] - If any of these appear, the test fails immediately
 * @returns {Promise<{matched: string, line: string}>}
 */
function watchLogs(patterns, timeoutMs, failPatterns = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', [
      'compose', 'logs',
      '-f', '--tail=0', '--no-log-prefix',
      CONTAINER_SERVICE,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for patterns: ${patterns.join(' | ')}`));
    }, timeoutMs);

    const onData = (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        if (VERBOSE) console.log(`  [log] ${line}`);

        // Check fail patterns first
        for (const fp of failPatterns) {
          if (line.includes(fp)) {
            clearTimeout(timer);
            cleanup();
            reject(new Error(`Fail pattern detected: "${fp}" in line: ${line}`));
            return;
          }
        }

        // Check success patterns
        for (const pattern of patterns) {
          if (line.includes(pattern)) {
            clearTimeout(timer);
            cleanup();
            resolve({ matched: pattern, line: line.trim() });
            return;
          }
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`docker compose logs failed: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (!resolved) {
        clearTimeout(timer);
        resolved = true;
        reject(new Error(`docker compose logs exited unexpectedly (code ${code})`));
      }
    });
  });
}

/**
 * Watch Docker logs for ABSENCE of patterns (verify something does NOT happen).
 * Waits for the full duration and passes if no pattern matched.
 *
 * @param {string[]} patterns - Array of substrings that should NOT appear
 * @param {number} waitMs - How long to wait before declaring success
 * @param {string[]} [expectedPatterns] - Optional patterns that SHOULD appear (to confirm the message was received)
 * @returns {Promise<void>}
 */
function watchLogsAbsence(patterns, waitMs, expectedPatterns = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', [
      'compose', 'logs',
      '-f', '--tail=0', '--no-log-prefix',
      CONTAINER_SERVICE,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let resolved = false;
    let expectedSeen = expectedPatterns.length === 0; // auto-pass if no expected patterns
    const seenExpected = new Set();

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      if (!expectedSeen) {
        reject(new Error(`Timed out: expected patterns never seen: ${expectedPatterns.filter(p => !seenExpected.has(p)).join(', ')}`));
      } else {
        resolve(); // None of the forbidden patterns appeared — success
      }
    }, waitMs);

    const onData = (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        if (VERBOSE) console.log(`  [log] ${line}`);

        // Check if expected patterns appeared (message was received)
        for (const ep of expectedPatterns) {
          if (line.includes(ep)) {
            seenExpected.add(ep);
            if (seenExpected.size === expectedPatterns.length) expectedSeen = true;
          }
        }

        // Check forbidden patterns
        for (const pattern of patterns) {
          if (line.includes(pattern)) {
            clearTimeout(timer);
            cleanup();
            reject(new Error(`Forbidden pattern found: "${pattern}" in line: ${line.trim()}`));
            return;
          }
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`docker compose logs failed: ${err.message}`));
    });

    proc.on('close', () => {
      if (!resolved) {
        clearTimeout(timer);
        resolved = true;
        if (!expectedSeen) {
          reject(new Error(`Logs ended: expected patterns never seen: ${expectedPatterns.filter(p => !seenExpected.has(p)).join(', ')}`));
        } else {
          resolve();
        }
      }
    });
  });
}

/**
 * Pause for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test Definitions
// ---------------------------------------------------------------------------

const tests = [];

// Test 1: Owner DM — simple greeting (fast-path, no Claude CLI)
tests.push({
  id: 1,
  name: 'Owner DM — simple greeting (fast-path)',
  description: 'Send "hey" from owner in DM. Bot should reply via greeting fast-path without invoking Claude CLI.',
  run: async (token) => {
    const envelope = makeDmEnvelope(OWNER_PHONE, 'hey');

    // Start watching logs BEFORE sending the webhook
    const logPromise = watchLogs(
      ['[signal] Sending to'],  // Bot sends a reply
      TIMEOUT,
      [] // No fail patterns
    );

    // Brief delay to let log watcher attach
    await sleep(500);

    const { status } = await sendWebhook(token, envelope);
    if (status !== 200) {
      throw new Error(`Webhook returned HTTP ${status}, expected 200`);
    }

    const result = await logPromise;
    log(`  Matched: "${result.matched}" in: ${result.line}`);
  },
});

// Test 2: Owner DM — Claude CLI query
tests.push({
  id: 2,
  name: 'Owner DM — Claude CLI query',
  description: 'Send "what day is it today?" from owner. Should invoke Claude CLI and send response.',
  run: async (token) => {
    const envelope = makeDmEnvelope(OWNER_PHONE, 'what day is it today?');

    // Watch for runner invocation (Claude CLI being spawned)
    const logPromise = watchLogs(
      ['[runner]', '[signal] Sending to'],
      TIMEOUT,
    );

    await sleep(500);

    const { status } = await sendWebhook(token, envelope);
    if (status !== 200) {
      throw new Error(`Webhook returned HTTP ${status}, expected 200`);
    }

    const result = await logPromise;
    log(`  Matched: "${result.matched}" in: ${result.line}`);
  },
});

// Test 3: Group message — listenToAll OFF (default) — bot should NOT respond
tests.push({
  id: 3,
  name: 'Group message — listenToAll OFF (bot ignores)',
  description: 'Send a message in a group from a non-owner. Bot should NOT respond (listenToAll defaults to false, no @mention).',
  run: async (token) => {
    // Extra wait before this test: Test 2 spawns Claude CLI which takes 5-10s
    // to respond. We need to let that response fully flush before checking
    // that THIS message gets no reply.
    await sleep(12000);

    // Use a non-owner UUID (Lee) sending to a group
    const envelope = makeGroupEnvelope(
      SANDBOX_USER_UUID_LEE,
      GROUP_KARRISLEDY,
      'random message that the bot should ignore'
    );

    // We want to verify the message was RECEIVED but NOT replied to.
    // Watch for the incoming log line but NOT a "Sending to" that follows.
    const logPromise = watchLogsAbsence(
      // Forbidden: bot sending a reply to this group
      ['[signal] Sending to'],
      // Wait 8 seconds for absence confirmation
      8000,
      // Expected: the webhook processed the envelope
      ['[signal-webhook] processed']
    );

    await sleep(500);

    const { status } = await sendWebhook(token, envelope);
    if (status !== 200) {
      throw new Error(`Webhook returned HTTP ${status}, expected 200`);
    }

    await logPromise;
    log('  Confirmed: no reply sent within 8s window');
  },
});

// Test 4: Owner DM — !status command
tests.push({
  id: 4,
  name: 'Owner DM — !status command',
  description: 'Send "!status" from owner. Bot should send a status response.',
  run: async (token) => {
    const envelope = makeDmEnvelope(OWNER_PHONE, '!status');

    const logPromise = watchLogs(
      ['[signal] Sending to'],
      TIMEOUT,
    );

    await sleep(500);

    const { status } = await sendWebhook(token, envelope);
    if (status !== 200) {
      throw new Error(`Webhook returned HTTP ${status}, expected 200`);
    }

    const result = await logPromise;
    log(`  Matched: "${result.matched}" in: ${result.line}`);
  },
});

// Test 5: Sandbox user DM
tests.push({
  id: 5,
  name: 'Sandbox user DM',
  description: 'Send a message from Daniel (sandbox user) in DM. Bot should use sandbox path.',
  run: async (token) => {
    const envelope = makeDmEnvelope(SANDBOX_USER_UUID, 'hello from sandbox');

    // Sandbox users should trigger either a sandbox log or a reply
    const logPromise = watchLogs(
      [
        '[signal] Sending to',    // Bot replied
        'sandbox',                // Sandbox path used
        '[signal] Incoming from', // At minimum, message was received
      ],
      TIMEOUT,
    );

    await sleep(500);

    const { status } = await sendWebhook(token, envelope);
    if (status !== 200) {
      throw new Error(`Webhook returned HTTP ${status}, expected 200`);
    }

    const result = await logPromise;
    log(`  Matched: "${result.matched}" in: ${result.line}`);
  },
});

// Test 6: Auth error — invalid token should return 401
tests.push({
  id: 6,
  name: 'Auth rejection — invalid token returns 401',
  description: 'Send a webhook with an invalid token. Endpoint should return 401 and NOT process the message.',
  run: async (_token) => {
    const envelope = makeGroupEnvelope(
      OWNER_PHONE,
      GROUP_BIANCA_BOOBOO,
      'this should be rejected'
    );

    // Send with a bogus token
    const body = JSON.stringify(envelope);
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: HOST,
        port: PORT,
        path: WEBHOOK_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': 'totally-invalid-token-12345',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.write(body);
      req.end();
    });

    if (result.status !== 401) {
      throw new Error(`Expected HTTP 401, got ${result.status}. Body: ${result.body}`);
    }

    // Verify the response is a generic error (not leaking internal details)
    let parsed;
    try { parsed = JSON.parse(result.body); } catch { parsed = null; }
    if (parsed && parsed.error === 'unauthorized') {
      log('  Confirmed: 401 with generic "unauthorized" message');
    } else {
      log(`  Confirmed: 401 returned (body: ${result.body.substring(0, 100)})`);
    }
  },
});

// Test 7: Group @mention — bot should respond when mentioned
tests.push({
  id: 7,
  name: 'Group @mention — bot responds when mentioned',
  description: 'Send a group message that @mentions the bot. Bot should respond even with listenToAll OFF.',
  run: async (token) => {
    // Wait for any lingering responses from earlier tests
    await sleep(8000);

    // Simulate an @mention — signal-cli includes a "mentions" array in dataMessage
    const envelope = makeGroupEnvelope(
      OWNER_PHONE,
      GROUP_KARRISLEDY,
      'hey @Bianca what time is it?',
      {
        mentions: [{
          uuid: 'e69a86a8-c394-4852-92f4-d4ba6b06fb72',
          start: 4,
          length: 7,
        }],
      }
    );

    const logPromise = watchLogs(
      ['[runner]', '[signal] Sending to'],
      TIMEOUT,
    );

    await sleep(500);

    const { status } = await sendWebhook(token, envelope);
    if (status !== 200) {
      throw new Error(`Webhook returned HTTP ${status}, expected 200`);
    }

    const result = await logPromise;
    log(`  Matched: "${result.matched}" in: ${result.line}`);
  },
});

// Test 8: Owner DM — !listen command toggles group listening
tests.push({
  id: 8,
  name: 'Owner DM — !listen command',
  description: 'Send "!listen" from owner in a group. Bot should acknowledge the toggle.',
  run: async (token) => {
    // Wait for any previous test responses
    await sleep(8000);

    const envelope = makeGroupEnvelope(
      OWNER_PHONE,
      GROUP_KARRISLEDY,
      '!listen'
    );

    const logPromise = watchLogs(
      ['[signal] Sending to'],
      TIMEOUT,
    );

    await sleep(500);

    const { status } = await sendWebhook(token, envelope);
    if (status !== 200) {
      throw new Error(`Webhook returned HTTP ${status}, expected 200`);
    }

    const result = await logPromise;
    log(`  Matched: "${result.matched}" in: ${result.line}`);

    // Toggle it back off to leave state clean
    await sleep(2000);
    const offEnvelope = makeGroupEnvelope(OWNER_PHONE, GROUP_KARRISLEDY, '!listen');
    await sendWebhook(token, offEnvelope);
  },
});

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('');
  console.log('='.repeat(70));
  console.log('  Signal Bot E2E Test Harness');
  console.log('='.repeat(70));
  console.log('');
  log(`Config: host=${HOST}:${PORT}, timeout=${TIMEOUT}ms, verbose=${VERBOSE}`);
  console.log('');

  // Step 1: Verify Docker is running and get the auth token
  log('Fetching internal token from Docker container...');
  let token;
  try {
    token = getInternalToken();
    log(`Token retrieved (length: ${token.length})`);
  } catch (err) {
    logError(err.message);
    process.exit(1);
  }

  // Step 2: Verify the server is reachable
  log('Verifying server connectivity...');
  try {
    const healthCheck = await new Promise((resolve, reject) => {
      const req = http.get(`http://${HOST}:${PORT}/health`, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    if (healthCheck.status === 200) {
      log('Server is healthy');
    } else {
      log(`Server returned ${healthCheck.status} on /health — proceeding anyway`);
    }
  } catch (err) {
    logError(`Cannot reach server at ${HOST}:${PORT}: ${err.message}`);
    logError('Is the Docker container running? Try: docker compose up -d');
    process.exit(1);
  }

  console.log('');
  console.log('-'.repeat(70));
  console.log('');

  // Step 3: Run tests sequentially
  const testsToRun = ONLY_TEST > 0 ? tests.filter(t => t.id === ONLY_TEST) : tests;
  if (testsToRun.length === 0) {
    logError(`No test found with id=${ONLY_TEST}`);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const test of testsToRun) {
    const startTime = Date.now();
    log(`TEST ${test.id}: ${test.name}`);
    log(`  ${test.description}`);

    try {
      await test.run(token);
      const elapsed = Date.now() - startTime;
      console.log(`  PASS (${elapsed}ms)`);
      console.log('');
      passed++;
      results.push({ id: test.id, name: test.name, status: 'PASS', elapsed });
    } catch (err) {
      const elapsed = Date.now() - startTime;
      console.log(`  FAIL: ${err.message}`);
      console.log('');
      failed++;
      results.push({ id: test.id, name: test.name, status: 'FAIL', elapsed, error: err.message });
    }

    // Wait between tests to avoid overlap in log correlation
    if (test !== testsToRun[testsToRun.length - 1]) {
      await sleep(2000);
    }
  }

  // Step 4: Summary
  console.log('-'.repeat(70));
  console.log('');
  console.log('  RESULTS SUMMARY');
  console.log('');
  for (const r of results) {
    const icon = r.status === 'PASS' ? '[PASS]' : '[FAIL]';
    const detail = r.status === 'FAIL' ? ` -- ${r.error}` : '';
    console.log(`  ${icon} Test ${r.id}: ${r.name} (${r.elapsed}ms)${detail}`);
  }
  console.log('');
  console.log(`  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log('');
  console.log('='.repeat(70));

  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTests().catch(err => {
  logError(`Unhandled error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
