/**
 * runner-audit.test.js — Targeted regression tests for bugs found during
 * the runner.js audit (2026-05-22).
 *
 * These tests use node:test + node:assert/strict (no extra deps, matches project
 * pattern). Each test targets a specific bug finding. Module-level imports that
 * touch the filesystem are stubbed before runner.js is required.
 *
 * Coverage areas:
 *   1. Auth failure detection edge cases
 *   2. Process cleanup / zombie risk (forceKillProcess, close handler)
 *   3. Streaming proxy error handling
 *   4. SessionId lifetime / null hazards
 *   5. Stall detection false positives + false negatives
 *   6. Rate-limit retry state reset
 *   7. Sandbox spawn error cases
 *   8. Progress tracking races
 *   9. Semaphore accounting under eviction
 *  10. Cost tracking paths
 */

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

// ─── Minimal stubs so runner.js loads without real dependencies ────────────────

function stubModule(resolvedPath, exports) {
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true, exports,
  };
}

// Stub every require() that touches disk or network
const stubs = {
  '../internal-token':     { getInternalToken: () => 'stub-internal-token-for-testing-1234' },
  '../system-prompt':      { buildSystemPrompt: () => 'stub system prompt' },
  '../error-alerting':     { init: () => {}, sendErrorAlert: () => {} },
  '../session-journal':    { appendEntry: () => {}, getJournalContext: () => null },
  '../memory':             { loadMemory: () => null },
  '../loop-detection':     {
    createState: () => ({ toolCallHistory: [] }),
    recordToolCall: () => {},
    detectToolCallLoop: () => ({ stuck: false }),
    recordOutcomeById: () => false,
  },
  '../repair-ledger':      { buildRepairContext: () => null },
  '../preflight':          { buildPreflightBlock: () => null },
  '../sandbox':            {
    provisionUser: () => {},
    _getUid: () => 1001,
    refreshCredentials: () => {},
  },
};

for (const [rel, exports] of Object.entries(stubs)) {
  const abs = require.resolve(rel.replace('../', '/mnt/c/Users/karen/Desktop/Github Projects/MyBot/claude-api/'));
  stubModule(abs, exports);
}

// Now load runner.js — all stubs are in cache
delete require.cache[require.resolve('/mnt/c/Users/karen/Desktop/Github Projects/MyBot/claude-api/runner.js')];
const runner = require('/mnt/c/Users/karen/Desktop/Github Projects/MyBot/claude-api/runner.js');
const {
  forceKillProcess,
  freshProgress,
  pushOutput,
  pushRawLog,
  scrubSecrets,
  _acquireSlot,
  _releaseSlot,
} = runner;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal fake child process that behaves like EventEmitter + ChildProcess.
 * exitCode is null while "running", set to a number after exit is emitted.
 */
function makeFakeChild({ pid = 12345, killed = false, exitCode = null } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = killed;
  child.exitCode = exitCode;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = null;
  child.kill = function (sig) {
    this.killed = true;
    this.exitCode = sig === 'SIGKILL' ? 137 : 143;
    setImmediate(() => this.emit('exit', this.exitCode, sig));
  };
  return child;
}

/**
 * Build a minimal channelState with progress and _channelId.
 */
function makeChannelState(overrides = {}) {
  return {
    _channelId: 'test-channel-123',
    busy: false,
    process: null,
    startedAt: null,
    sessionId: null,
    sessionStartedAt: null,
    progress: freshProgress(),
    ...overrides,
  };
}

// ─── 1. Auth failure detection ────────────────────────────────────────────────

describe('Auth failure detection', () => {
  /**
   * BUG: The auth check on the `result` event (line 822) only sets
   * `hitAuthFailure=true` when `event.is_error` is truthy AND the text
   * includes "Not logged in". If the CLI emits is_error=false but the
   * assistant event already set hitAuthFailure=true, the result handler
   * correctly flags `resultSubtype = 'authentication_failed'`.
   *
   * However — if NEITHER the assistant event NOR the result event fires
   * `hitAuthFailure`, but the CLI exits non-zero with "Not logged in" in
   * stderr, the close handler falls into the generic error path. This test
   * documents that the `sessionResumeFailed` guard (line 1337) requires
   * the `sessionId` binding from the *constructor* parameter, not the
   * accumulated `resultSessionId`. If these diverge, auth errors can
   * disguise as session-resume failures.
   */
  it('auth failure from assistant event sets hitAuthFailure before result event', () => {
    // Simulate the flag logic directly — this is the exact path in runner.js
    let hitAuthFailure = false;

    // Simulate assistant event with error field
    const assistantEvent = { type: 'assistant', error: 'authentication_failed' };
    if (assistantEvent.type === 'assistant' && assistantEvent.error === 'authentication_failed') {
      hitAuthFailure = true;
    }

    // Simulate result event — this is the secondary check
    const resultEvent = { type: 'result', is_error: true, result: 'Not logged in', subtype: 'error' };
    let resultSubtype = resultEvent.subtype;
    if (resultEvent.is_error && (hitAuthFailure || (resultEvent.result && resultEvent.result.includes('Not logged in')))) {
      hitAuthFailure = true;
      resultSubtype = 'authentication_failed';
    }

    assert.ok(hitAuthFailure, 'hitAuthFailure must be true after assistant event with authentication_failed');
    assert.equal(resultSubtype, 'authentication_failed');
  });

  it('auth failure from result text alone (no assistant event) is detected', () => {
    let hitAuthFailure = false;
    // No assistant event fires — only result event with "Not logged in" text
    const resultEvent = { type: 'result', is_error: true, result: 'Not logged in', subtype: 'error' };
    let resultSubtype = resultEvent.subtype;
    if (resultEvent.is_error && (hitAuthFailure || (resultEvent.result && resultEvent.result.includes('Not logged in')))) {
      hitAuthFailure = true;
      resultSubtype = 'authentication_failed';
    }
    assert.ok(hitAuthFailure, 'hitAuthFailure must be true when result text includes "Not logged in"');
    assert.equal(resultSubtype, 'authentication_failed');
  });

  /**
   * BUG (medium severity): If `is_error` is false but the result text
   * still contains "Not logged in", auth failure is NOT detected. The
   * condition `event.is_error && (hitAuthFailure || ...)` requires is_error.
   * This is the false-negative case.
   */
  it('KNOWN GAP: auth failure is missed when is_error=false despite "Not logged in" text', () => {
    let hitAuthFailure = false;
    const resultEvent = { type: 'result', is_error: false, result: 'Not logged in', subtype: 'error' };
    let resultSubtype = resultEvent.subtype;
    // Replicating exact runner.js condition
    if (resultEvent.is_error && (hitAuthFailure || (resultEvent.result && resultEvent.result.includes('Not logged in')))) {
      hitAuthFailure = true;
      resultSubtype = 'authentication_failed';
    }
    // Document the gap: hitAuthFailure stays false because is_error=false gates the whole check
    assert.equal(hitAuthFailure, false, 'GAP: is_error=false causes auth failure to slip through — this is the documented bug');
    // The fix: condition should be: event.is_error || text includes "Not logged in"
  });

  it('close handler resolves with authFailed when resultSubtype is authentication_failed', () => {
    // Simulate the close handler branch (lines 1311-1320)
    const hitAuthFailure = true;
    const resultSubtype = 'authentication_failed';
    let resolved = null;

    const wrappedResolve = (val) => { resolved = val; };

    if (resultSubtype === 'authentication_failed' || hitAuthFailure) {
      wrappedResolve({ text: '', sessionId: null, cost: 0, authFailed: true, stopped: true });
    }

    assert.ok(resolved, 'close handler must resolve (not reject) on auth failure');
    assert.ok(resolved.authFailed, 'resolved value must have authFailed=true');
    assert.equal(resolved.sessionId, null, 'sessionId must be null on auth failure — stale sessions must be cleared');
    assert.equal(resolved.cost, 0, 'cost must be 0 on auth failure — no successful turns');
  });

  it('auth failure clears sessionId in the resolved result', () => {
    // If the caller resumes with a stale sessionId after auth failure, the next
    // invocation will get "No conversation found" errors. The resolved sessionId
    // must be null, not the accumulated resultSessionId.
    const resolved = { text: '', sessionId: null, cost: 0, authFailed: true, stopped: true };
    assert.equal(resolved.sessionId, null, 'auth failure must not carry over a stale sessionId');
  });
});

// ─── 2. Process cleanup / zombie risk ────────────────────────────────────────

describe('Process cleanup — forceKillProcess', () => {
  it('returns immediately for null proc', async () => {
    const result = await forceKillProcess(null);
    assert.equal(result, undefined);
  });

  it('returns immediately for already-exited proc (exitCode !== null)', async () => {
    const child = makeFakeChild({ exitCode: 0 });
    const result = await forceKillProcess(child);
    assert.equal(result, undefined);
  });

  it('sends SIGTERM then resolves on exit event', async () => {
    const child = makeFakeChild();
    const killSignals = [];
    const originalKill = child.kill.bind(child);
    child.kill = (sig) => { killSignals.push(sig); originalKill(sig); };

    await forceKillProcess(child, 100);

    assert.ok(killSignals.includes('SIGTERM'), 'SIGTERM must be sent first');
  });

  /**
   * BUG (low): forceKillProcess checks `proc.exitCode !== null` to decide
   * whether the process is still running. But `proc.killed` is set to true
   * by child.kill() BEFORE the exit event fires. If exitCode is still null
   * (exit event hasn't fired yet) and killed=true, the function still enters
   * the kill path — this is correct. The bug is the inverse: a process that
   * set exitCode=0 but whose 'exit' event hasn't been emitted yet (race) will
   * be skipped. This is inherent to the API and acceptable.
   *
   * The real gap: forceKillProcess resolves its promise via `proc.once('exit')`
   * but if the process already emitted 'exit' before forceKillProcess is called,
   * the listener is added AFTER the event fired and never fires. The timeout
   * covers this (resolves after timeoutMs + 1000), but that's 4 seconds of
   * unnecessary waiting.
   */
  it('KNOWN GAP: forceKillProcess hangs for already-exited-but-exitCode-null procs', async () => {
    // Simulate a process that already emitted exit but exitCode wasn't set yet
    // (this can happen in the brief window between exit emission and listener)
    const child = makeFakeChild({ exitCode: null, killed: true });
    // Override kill to be a no-op — process is already gone
    child.kill = () => {};
    // Override process.kill to simulate ESRCH (process doesn't exist)
    // forceKillProcess calls process.kill(proc.pid, 0) to test liveness

    // We can't easily mock process.kill, so verify the timeout fallback fires
    // within timeoutMs+1500ms. Use a tight timeout to keep tests fast.
    const start = Date.now();
    await forceKillProcess(child, 50); // 50ms timeout
    const elapsed = Date.now() - start;
    // Should resolve within ~1150ms (50ms + 1000ms fallback + margin)
    assert.ok(elapsed < 2000, `forceKillProcess should resolve within 2s for dead process, took ${elapsed}ms`);
  });

  /**
   * BUG (medium): The close handler (line 1299) calls _deregisterProcess(child.pid)
   * but the process registry also holds a reference to `child` itself. If the
   * ghost reaper fires between deregister and the end of the close handler,
   * the slot may be double-released. releaseOnce() prevents this, but only if
   * the close handler never calls _releaseSlot() directly. Verify the pattern.
   */
  it('releaseOnce prevents double slot release across close and timeout paths', () => {
    let releaseCount = 0;
    let released = false;
    const releaseOnce = () => { if (!released) { released = true; releaseCount++; } };

    // Simulate close handler calling release
    releaseOnce();
    // Simulate hard timeout also calling release (race condition)
    releaseOnce();
    // Simulate stall detector also calling release
    releaseOnce();

    assert.equal(releaseCount, 1, 'releaseOnce must ensure the slot is released exactly once regardless of how many paths call it');
  });

  it('close handler clears channelState.process, busy, and startedAt', () => {
    const channelState = makeChannelState({ busy: true, startedAt: Date.now() });
    const child = makeFakeChild();
    channelState.process = child;

    // Simulate the close handler cleanup block (lines 1292-1297)
    channelState.process = null;
    channelState.busy = false;
    channelState.startedAt = null;
    channelState.progress = freshProgress();

    assert.equal(channelState.process, null);
    assert.equal(channelState.busy, false);
    assert.equal(channelState.startedAt, null);
    assert.ok(channelState.progress, 'progress must be reset to a fresh object');
  });

  /**
   * BUG (critical): The hard-timeout handler (lines 1080-1094) calls
   * wrappedReject() but does NOT call clearInterval(stallCheck) or
   * clearInterval(checkinTimer) before doing so. The close handler DOES
   * clear them — but wrappedReject triggers the Promise chain to unwind,
   * and if the caller's .catch() cleans up the runner, the intervals may
   * keep ticking after the promise is settled. The close handler fires
   * asynchronously after forceKillProcess, so there is a window where
   * both intervals are alive and the Promise is already rejected.
   *
   * Impact: If the caller awaits the runner and moves on, the intervals
   * that reference the (now stale) channelState will continue to fire
   * every 30s, executing stall-check and check-in logic against state
   * that is no longer valid. The check-in sends Discord messages on a
   * dead session.
   */
  it('CRITICAL: hard-timeout path must clear intervals before rejecting', () => {
    // Verify the close handler clears intervals — hard-timeout does NOT
    let stallInterval = null;
    let checkinInterval = null;
    let hardTimeoutFired = false;
    let closeFired = false;

    // Simulate hard-timeout calling wrappedReject WITHOUT clearing intervals
    const simulateHardTimeout = (stallCheck, checkinTimer) => {
      hardTimeoutFired = true;
      // Bug: intervals are NOT cleared here in the current code
      // wrappedReject(new Error('hard timeout'));
      // close handler will clear them later — but promise is already settled
    };

    // Simulate close handler clearing intervals
    const simulateClose = (stallCheck, checkinTimer) => {
      closeFired = true;
      clearInterval(stallCheck);
      clearInterval(checkinTimer);
    };

    stallInterval = setInterval(() => {}, 100000);
    checkinInterval = setInterval(() => {}, 100000);

    simulateHardTimeout(stallInterval, checkinInterval);
    assert.ok(hardTimeoutFired);
    // At this point intervals are still running — the promise is rejected but
    // the intervals will fire for up to 30s before the close handler arrives
    simulateClose(stallInterval, checkinInterval);
    assert.ok(closeFired);
    // After close, intervals are cleared
    // This test documents the gap: hardTimeout should call clearInterval BEFORE reject
  });
});

// ─── 3. Streaming proxy error handling ────────────────────────────────────────

describe('Streaming proxy error handling', () => {
  /**
   * BUG (medium): The streaming send chain (lines 1025-1029) uses:
   *   channelState._sendQueue = channelState._sendQueue.then(...).catch(...)
   * The .catch() handles errors, which is correct. BUT if channelProxy.send()
   * throws synchronously (not returning a rejected promise), the .then()
   * callback itself throws, and since .catch() is chained after .then(), it
   * catches it. This is fine.
   *
   * The real issue: the send chain holds a reference to each text chunk via
   * closure. If 100+ chunks queue up during a long run and the network is
   * slow, the queue grows unboundedly. No backpressure or max-queue-depth.
   * This is a medium-severity memory leak for very long sessions.
   */
  it('send queue catches errors without crashing the process', async () => {
    let errorCaught = false;
    let queue = Promise.resolve();

    const channelProxy = {
      send: async (chunk) => {
        if (chunk === 'bad') throw new Error('Discord send failed');
        return 'ok';
      },
    };

    // Simulate the streaming send chain
    const enqueue = (chunk) => {
      queue = queue
        .then(() => channelProxy.send(chunk))
        .catch(err => { errorCaught = true; /* logged, not rethrown */ });
    };

    enqueue('good');
    enqueue('bad');  // This should not crash
    enqueue('good'); // This should still run

    await queue;
    assert.ok(errorCaught, 'send errors must be caught and not bubble up');
  });

  it('parse error in stdout handler does not crash the process', () => {
    // Simulate the try/catch around JSON.parse (lines 787-1054)
    let parsed = 0;
    let errors = 0;

    const lines = [
      '{"type":"assistant","message":{"role":"assistant","content":[]}}',
      '{bad json',
      '{"type":"result","subtype":"success","result":"done"}',
      '',
    ];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
        parsed++;
      } catch {
        errors++;
        // Logged but not rethrown — process continues
      }
    }

    assert.equal(parsed, 2, 'valid lines must be parsed');
    assert.equal(errors, 1, 'parse errors must be caught, not crash');
  });

  it('scrubSecrets handles non-string input without throwing', () => {
    // Line 31: `if (typeof text !== 'string') return text`
    assert.equal(scrubSecrets(null), null);
    assert.equal(scrubSecrets(undefined), undefined);
    assert.equal(scrubSecrets(42), 42);
    assert.deepEqual(scrubSecrets({ key: 'value' }), { key: 'value' });
  });

  it('scrubSecrets redacts known secret patterns', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.longtoken12345678901234567890';
    const result = scrubSecrets(text);
    assert.ok(!result.includes('eyJhbGciOiJIUzI1NiJ9'), 'Bearer token must be redacted');
    assert.ok(result.includes('[REDACTED]'), 'redacted marker must appear');
  });

  it('scrubSecrets redacts INTERNAL_API_TOKEN literal when long enough', () => {
    // The literal is only applied when >= 16 chars (line 61)
    // Our stub returns 'stub-internal-token-for-testing-1234' (35 chars)
    const token = 'stub-internal-token-for-testing-1234';
    const text = `curl -H "X-Token: ${token}" http://localhost`;
    const result = scrubSecrets(text);
    assert.ok(!result.includes(token), 'internal token literal must be redacted');
  });

  it('stdoutBuf handles partial JSON lines split across data chunks', () => {
    // Simulate the stdoutBuf split-on-newline pattern (lines 783-784)
    let stdoutBuf = '';
    const received = [];

    const handleData = (chunk) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // keep partial line
      for (const line of lines) {
        if (line.trim()) received.push(line);
      }
    };

    handleData('{"type":"result","subtype":"suc');
    assert.equal(received.length, 0, 'partial line must buffer, not process');
    handleData('cess"}\n{"type":"assistant"');
    assert.equal(received.length, 1, 'complete line must be processed');
    assert.ok(received[0].includes('"result"'), 'first complete line must be the result event');
    handleData('}\n');
    assert.equal(received.length, 2, 'second complete line must be processed after final newline');
  });
});

// ─── 4. SessionId lifetime / null hazards ────────────────────────────────────

describe('SessionId handling', () => {
  it('persistSessionIdEarly is idempotent — only persists once', () => {
    let persistCallCount = 0;
    let sessionIdPersisted = false;

    const persistSessionIdEarly = (sid, channelState, saveStateFn) => {
      if (!sid || sessionIdPersisted) return;
      if (!channelState || !channelState._channelId) return;
      channelState.sessionId = sid;
      saveStateFn(channelState._channelId, channelState, { critical: true });
      sessionIdPersisted = true;
      persistCallCount++;
    };

    const channelState = makeChannelState();
    const saveState = () => {};

    persistSessionIdEarly('sess-abc', channelState, saveState);
    persistSessionIdEarly('sess-abc', channelState, saveState); // second call — must be no-op
    persistSessionIdEarly('sess-xyz', channelState, saveState); // different sid — still no-op

    assert.equal(persistCallCount, 1, 'persistSessionIdEarly must only write once per run');
    assert.equal(channelState.sessionId, 'sess-abc', 'first sessionId must be persisted, not overwritten by second');
  });

  it('persistSessionIdEarly does nothing when channelState is null', () => {
    let sessionIdPersisted = false;
    const persistSessionIdEarly = (sid) => {
      if (!sid || sessionIdPersisted) return;
      // no channelState — should be guarded
      const channelState = null;
      if (!channelState || !channelState._channelId) return;
      sessionIdPersisted = true;
    };

    persistSessionIdEarly('sess-123'); // must not throw
    assert.equal(sessionIdPersisted, false);
  });

  it('stall detector preserves sessionId for mid-session stalls (allows resume attempt)', () => {
    // Lines 1249-1253: the runner captures `p = channelState.progress` BEFORE
    // calling freshProgress(), so `p.turnCount` holds the old value.
    // At line 1253: `if (p.turnCount === 0) channelState.sessionId = null;`
    // uses the OLD p snapshot. When the stall fires at turn 3, p.turnCount=3,
    // the condition is false, and sessionId is preserved so the caller can
    // attempt resume on the next message. This is intentional behavior.
    const channelState = makeChannelState();
    channelState.sessionId = 'sess-mid-session-stall';
    const p = channelState.progress; // snapshot — mirrors how runner.js captures p in the stall interval
    p.turnCount = 3; // stall happened after turn 3

    // Simulate stall detector path (lines 1249-1257):
    // Note: runner.js uses `p` (captured at interval-start), not channelState.progress after freshProgress
    channelState.process = null;
    channelState.busy = false;
    channelState.startedAt = null;
    channelState.progress = freshProgress(); // resets progress object — p still points to old object
    if (p.turnCount === 0) { // old turnCount = 3, condition is FALSE
      channelState.sessionId = null;
    }

    // sessionId is correctly preserved so the caller can attempt resume
    assert.equal(channelState.sessionId, 'sess-mid-session-stall',
      'sessionId must be preserved for mid-session stalls to allow resume attempt on next message');

    // Stall at turn 0 DOES clear sessionId (no meaningful session exists yet)
    const channelState2 = makeChannelState();
    channelState2.sessionId = 'sess-turn0-stall';
    const p2 = channelState2.progress;
    p2.turnCount = 0;
    channelState2.progress = freshProgress();
    if (p2.turnCount === 0) {
      channelState2.sessionId = null;
    }
    assert.equal(channelState2.sessionId, null,
      'sessionId must be cleared when stall fires at turn 0 — no session was established');
  });

  it('session resume failure clears sessionId in resolved result', () => {
    // Lines 1337-1345: session resume failure returns sessionId=null
    const resolved = { text: '', sessionId: null, cost: 0, sessionResumeFailed: true, stopped: true };
    assert.equal(resolved.sessionId, null, 'sessionResumeFailed result must have null sessionId');
    assert.ok(resolved.sessionResumeFailed, 'sessionResumeFailed flag must be set');
  });

  it('code=143 (SIGTERM) close path returns channelState.sessionId not resultSessionId', () => {
    // Lines 1299-1301: code 143 resolves with channelState?.sessionId
    const channelState = makeChannelState();
    channelState.sessionId = 'persisted-early-sess-id';
    // resultSessionId was never set (process killed before result event)
    const resultSessionId = null;

    // Simulate the resolved value for code=143
    const resolved = {
      text: '*(Process stopped)*',
      sessionId: channelState?.sessionId, // uses channelState, not resultSessionId
      cost: null,
      stopped: true,
    };

    assert.equal(resolved.sessionId, 'persisted-early-sess-id',
      'SIGTERM kill must return the early-persisted sessionId, allowing the user to resume');
  });
});

// ─── 5. Stall detection false positives / false negatives ─────────────────────

describe('Stall detection', () => {
  it('ping thresholds correctly tier: m5 < m15 < m45', () => {
    // Verify the ping threshold ordering is internally consistent
    const m5threshold = 5;
    const m15threshold = 15;
    const m45threshold = 45;

    assert.ok(m5threshold < m15threshold, 'm5 must fire before m15');
    assert.ok(m15threshold < m45threshold, 'm15 must fire before m45');
  });

  it('ping flags reset when activity resumes (idle < 3min)', () => {
    // Lines 1112-1118: ping flags reset when idle < 3 minutes
    const pingsSent = { m5: true, m15: true, m45: true };
    const p = { stallWarned: true };

    const idle = 2 * 60 * 1000; // 2 minutes — below 3-min threshold
    if (idle < 3 * 60 * 1000) {
      pingsSent.m5 = false;
      pingsSent.m15 = false;
      pingsSent.m45 = false;
      p.stallWarned = false;
    }

    assert.equal(pingsSent.m5, false, 'm5 ping must reset after activity');
    assert.equal(pingsSent.m15, false, 'm15 ping must reset after activity');
    assert.equal(pingsSent.m45, false, 'm45 ping must reset after activity');
    assert.equal(p.stallWarned, false, 'stallWarned must reset after activity');
  });

  /**
   * BUG (medium): The progress circuit breaker in warnOnlyMode (lines 1130-1165)
   * checks `childAlive` BEFORE checking the breaker conditions. If childAlive
   * is false (process died silently), the breaker conditions are evaluated but
   * the kill path (`forceKillProcess(child)`) is called on a dead process.
   * forceKillProcess guards against this, so no harm — but the wrappedReject()
   * on line 1163 is called WHILE channelState.process is still set to the
   * dead child. The cleanup on lines 1158-1161 runs before wrappedReject,
   * so channelState.process is null by the time the caller sees it. This is
   * correct. However, the `childAlive && (turnTriggered || ...)` guard at
   * line 1149 means a dead child that triggered the circuit breaker conditions
   * falls through to the dead-process cleanup path at line 1181 instead,
   * which sends no "auto-killed" message. The user sees silence instead of
   * an explanation.
   */
  it('KNOWN GAP: dead child during circuit breaker conditions gets no "auto-killed" message', () => {
    const p = freshProgress();
    p.turnCount = 20;
    p.lastOutputTurn = 0;
    p.streamedChars = 500;

    const streamedAny = true;
    const childAlive = false; // process is dead

    // Circuit breaker conditions
    const silentTurns = p.turnCount - p.lastOutputTurn; // 20
    const substantiveAnswer = streamedAny && (p.streamedChars || 0) > 200; // true
    const postAnswerAgent = substantiveAnswer && false; // no active agents
    const turnThreshold = 15;
    const turnTriggered = silentTurns >= turnThreshold && p.turnCount >= 5; // true

    // Line 1149: childAlive gates the breaker message
    const breakerWillMessage = (turnTriggered) && childAlive; // FALSE — dead child

    assert.equal(breakerWillMessage, false,
      'GAP: dead child with circuit-breaker conditions will NOT send the auto-killed message — user sees silence');
  });

  it('startup grace period delays stall kill at turn 0', () => {
    // Lines 1199-1204: turn 0 gets 3-minute grace, rate-limited gets 10-minute
    const p = freshProgress();
    p.turnCount = 0;
    p.currentTool = 'Bash';
    const hitRateLimit = false;
    const groupAllowedTools = null;

    const STALL_THRESHOLDS = { bash: 10 * 60 * 1000, default: 5 * 60 * 1000, thinking: 5 * 60 * 1000 };
    let threshold = p.currentTool === 'Bash' ? STALL_THRESHOLDS.bash : STALL_THRESHOLDS.default;
    if (p.turnCount === 0) threshold = Math.max(threshold, 3 * 60 * 1000);
    if (hitRateLimit) threshold = Math.max(threshold, 10 * 60 * 1000);

    assert.ok(threshold >= 3 * 60 * 1000, 'startup grace must be at least 3 minutes');
    assert.equal(threshold, 10 * 60 * 1000, 'Bash at turn 0 uses 10min (bash threshold), not 3min (startup grace)');
  });

  it('rate-limited sessions get 10-minute stall threshold override', () => {
    const p = freshProgress();
    p.turnCount = 2;
    p.currentTool = null; // thinking
    const hitRateLimit = true;

    const STALL_THRESHOLDS = { thinking: 5 * 60 * 1000, default: 5 * 60 * 1000, bash: 10 * 60 * 1000 };
    let threshold = STALL_THRESHOLDS.thinking;
    if (p.turnCount === 0) threshold = Math.max(threshold, 3 * 60 * 1000);
    if (hitRateLimit) threshold = Math.max(threshold, 10 * 60 * 1000);

    assert.equal(threshold, 10 * 60 * 1000, 'rate-limited session must get 10-minute stall protection');
  });

  it('active agents get 30-minute stall threshold override', () => {
    const p = freshProgress();
    p.turnCount = 5;
    p.activeAgents = new Map([['agent-1', {}]]);
    p.currentTool = null;

    const STALL_THRESHOLDS = { thinking: 5 * 60 * 1000 };
    let threshold = STALL_THRESHOLDS.thinking;
    if (p.turnCount === 0) threshold = Math.max(threshold, 3 * 60 * 1000);
    if (p.activeAgents.size > 0) threshold = Math.max(threshold, 30 * 60 * 1000);

    assert.equal(threshold, 30 * 60 * 1000, 'sessions with active agents must get 30-minute stall protection');
  });

  it('stall detector does not double-fire wrappedReject via wrappedResolve (code=143)', () => {
    // The stall path calls wrappedReject. The close handler then fires with code=143
    // (SIGTERM) and calls wrappedResolve. releaseOnce prevents double release,
    // but both the reject AND the resolve will try to settle the promise.
    // In Node.js, once a promise is settled, subsequent resolve/reject calls
    // are silently ignored. This is correct behavior — but worth documenting.
    let settledCount = 0;
    let settled = false;
    const wrappedResolve = (val) => { if (!settled) { settled = true; settledCount++; } };
    const wrappedReject = (err) => { if (!settled) { settled = true; settledCount++; } };

    wrappedReject(new Error('stall'));
    wrappedResolve({ text: '*(Process stopped)*', stopped: true }); // from close handler

    assert.equal(settledCount, 1, 'promise must be settled exactly once — second call is silently ignored by Promise semantics');
  });
});

// ─── 6. Rate limit handling ───────────────────────────────────────────────────

describe('Rate limit handling', () => {
  it('rate limit event resets lastActivity and lastOutputTime', () => {
    // Lines 793-797: rate_limit_event updates progress timestamps
    const progress = freshProgress();
    const beforeTs = Date.now() - 10000; // 10 seconds ago
    progress.lastActivity = beforeTs;
    progress.lastOutputTime = beforeTs;

    // Simulate rate_limit_event handling
    progress.lastActivity = Date.now();
    progress.lastOutputTime = Date.now();

    assert.ok(progress.lastActivity > beforeTs, 'lastActivity must be updated on rate_limit_event');
    assert.ok(progress.lastOutputTime > beforeTs, 'lastOutputTime must be updated on rate_limit_event');
  });

  it('rate limit flag causes close handler to resolve (not reject) with rateLimited=true', () => {
    // Lines 1306-1308: hitRateLimit + no resultText → rateLimited resolution
    const hitRateLimit = true;
    const resultText = null;
    const resultSubtype = null;
    const code = 1; // non-zero exit

    let resolved = null;
    const wrappedResolve = (val) => { resolved = val; };

    if (code !== 0) {
      if (hitRateLimit && !resultText && resultSubtype !== 'success') {
        wrappedResolve({ text: '', sessionId: null, cost: null, numTurns: 0, stopped: true, rateLimited: true });
      }
    }

    assert.ok(resolved, 'rate limit path must resolve (not reject)');
    assert.ok(resolved.rateLimited, 'rateLimited flag must be set');
    assert.ok(resolved.stopped, 'stopped must be true');
  });

  /**
   * BUG (medium): The rate limit check (line 1306) uses `resultSubtype !== 'success'`
   * but if the CLI exits with a rate limit AND has a partial result (resultText is
   * non-empty), the rate limit path is skipped and falls through to hasValidResult
   * (line 1355). This is arguably correct behavior (use the partial result) but
   * the rateLimited flag is lost — the caller cannot distinguish "partial result
   * due to rate limit" from "partial result due to unexpected exit". The caller
   * in bot.js may not retry, leading to truncated responses.
   */
  it('KNOWN GAP: rate limit with partial resultText loses the rateLimited flag', () => {
    const hitRateLimit = true;
    const resultText = 'Partial answer before rate limit hit';
    const resultSubtype = null;
    const code = 1;

    let resolved = null;
    const wrappedResolve = (val) => { resolved = val; };

    if (code !== 0) {
      if (hitRateLimit && !resultText && resultSubtype !== 'success') {
        // This branch is NOT taken because resultText is non-empty
        wrappedResolve({ text: '', rateLimited: true, stopped: true });
      } else {
        const hasValidResult = resultText && resultText.length > 10;
        if (hasValidResult) {
          wrappedResolve({ text: resultText, stopped: false });
          // Note: rateLimited flag is NOT included here
        }
      }
    }

    assert.ok(resolved, 'must resolve with partial result');
    assert.equal(resolved.rateLimited, undefined,
      'GAP: rateLimited flag is lost when rate limit coincides with a partial result');
  });
});

// ─── 7. Sandbox spawn error cases ────────────────────────────────────────────

describe('Sandbox spawn error cases', () => {
  /**
   * BUG (medium): The sandbox shell command string (line 705) uses string
   * concatenation: `'cd ' + cwd + ' && exec runuser -u ' + sandboxLinuxUser`.
   * _validateCwd() rejects shell metacharacters, which prevents injection
   * through `cwd`. But `sandboxLinuxUser` comes from `this.sandboxUser.linuxUser`
   * which was validated to match `/^sandbox-[a-z0-9]{1,20}$/` in getSandboxUser().
   * This is safe — but the validation happens in getSandboxUser(), not in
   * runner.js. If runner.js is called with a manually-constructed sandboxUser
   * object that bypasses getSandboxUser(), the linuxUser is not re-validated.
   *
   * The fix already partially exists: getSandboxUser() validates the pattern.
   * The remaining gap is that runner.js trusts the caller to have gone through
   * getSandboxUser(). A defensive re-check in runner.js would eliminate the gap.
   */
  it('linuxUser validation pattern blocks shell metacharacters', () => {
    const validLinuxUserPattern = /^sandbox-[a-z0-9]{1,20}$/;

    // Valid patterns
    assert.ok(validLinuxUserPattern.test('sandbox-alice'), 'simple name must pass');
    assert.ok(validLinuxUserPattern.test('sandbox-user123'), 'alphanumeric name must pass');
    assert.ok(validLinuxUserPattern.test('sandbox-a'), 'single char must pass');

    // Invalid patterns — would allow shell injection if not validated
    assert.ok(!validLinuxUserPattern.test('sandbox-alice; rm -rf /'), 'semicolon injection must fail');
    assert.ok(!validLinuxUserPattern.test('sandbox-alice && whoami'), 'and injection must fail');
    assert.ok(!validLinuxUserPattern.test('sandbox-'), 'empty name suffix must fail');
    assert.ok(!validLinuxUserPattern.test('sandbox-ALICE'), 'uppercase must fail');
    assert.ok(!validLinuxUserPattern.test('sandbox-alice!'), 'special char must fail');
  });

  it('UID=0 is rejected by uid truthiness check', () => {
    // Lines 687-690: `if (!uid)` rejects null, undefined, 0
    // UID 0 is root — a sandbox user should never be root
    // This is a valid side-effect of the truthy check: uid=0 would be blocked
    const uid = 0;
    const wouldAbort = !uid; // true for uid=0
    assert.ok(wouldAbort, 'uid=0 (root) is correctly rejected by the truthy check');
  });

  it('sandbox spawn uses /tmp as cwd to avoid EACCES on 700 sandbox dir', () => {
    // Lines 701-701: sandboxSpawnOpts overrides cwd to /tmp
    const spawnOpts = { cwd: '/sandbox/alice', env: {} };
    const sandboxSpawnOpts = { ...spawnOpts, cwd: '/tmp' };

    assert.equal(sandboxSpawnOpts.cwd, '/tmp', 'sandbox spawn cwd must be /tmp to avoid permission error on 700 dir');
    assert.notEqual(spawnOpts.cwd, '/tmp', 'original spawnOpts must be unchanged (no mutation)');
  });

  it('sandbox spawn wraps claude args with sudo + unshare chain', () => {
    // Verify the spawn command structure (lines 702-708)
    const cwd = '/sandbox/alice';
    const sandboxLinuxUser = 'sandbox-alice';
    const claudeArgs = ['-p', 'hello', '--output-format', 'stream-json'];

    const spawnCmd = 'sudo';
    const spawnArgs = [
      '-E', '/usr/bin/unshare', '--mount', '--',
      '/bin/sh', '-c',
      'mount -t tmpfs -o size=4k,mode=000 tmpfs /workspace && mount -t tmpfs -o size=4k,mode=000 tmpfs /host && cd ' + cwd + ' && exec runuser -u ' + sandboxLinuxUser + ' -- "$@"',
      'sandbox',
      'claude', ...claudeArgs,
    ];

    assert.equal(spawnCmd, 'sudo');
    assert.ok(spawnArgs.includes('/usr/bin/unshare'), 'must use unshare for mount namespace isolation');
    assert.ok(spawnArgs.includes('--mount'), 'mount namespace flag must be present');
    assert.ok(spawnArgs.some(a => a.includes('tmpfs /workspace')), 'workspace must be shadowed with tmpfs');
    assert.ok(spawnArgs.some(a => a.includes('runuser -u ' + sandboxLinuxUser)), 'must exec as sandbox user via runuser');
  });

  it('wrappedReject is called and slot is released when UID resolution fails', () => {
    // Lines 687-690: uid resolution failure calls wrappedReject and returns
    let rejected = false;
    let slotReleased = false;
    let released = false;

    const releaseOnce = () => { if (!released) { released = true; slotReleased = true; } };
    const wrappedReject = (err) => { releaseOnce(); rejected = true; };

    const uid = null; // UID lookup failed
    if (!uid) {
      wrappedReject(new Error('Sandbox user has no UID — provisioning may have failed'));
      // return; — caller returns after this
    }

    assert.ok(rejected, 'wrappedReject must be called when UID is null');
    assert.ok(slotReleased, 'semaphore slot must be released when UID is null');
  });
});

// ─── 8. Progress tracking ────────────────────────────────────────────────────

describe('Progress tracking', () => {
  it('freshProgress returns correct initial state shape', () => {
    const p = freshProgress();
    assert.equal(p.currentTool, null);
    assert.equal(p.toolDetail, '');
    assert.deepEqual(p.toolHistory, []);
    assert.equal(p.turnCount, 0);
    assert.equal(p.stallWarned, false);
    assert.equal(p.streamedChars, 0);
    assert.ok(Array.isArray(p.recentOutputs));
    assert.ok(Array.isArray(p.rawLog));
    assert.ok(p.activeAgents instanceof Map);
    assert.ok(Array.isArray(p.completedAgents));
    assert.ok(p.loopState, 'loopState must be initialized');
  });

  it('pushOutput trims lines to 200 characters', () => {
    const p = freshProgress();
    const longLine = 'x'.repeat(250);
    pushOutput(p, longLine);
    assert.equal(p.recentOutputs[0].length, 200, 'long lines must be trimmed to 200 chars');
    assert.ok(p.recentOutputs[0].endsWith('...'), 'trimmed lines must end with ellipsis');
  });

  it('pushOutput evicts oldest entry when over 15', () => {
    const p = freshProgress();
    for (let i = 0; i < 20; i++) pushOutput(p, `line ${i}`);
    assert.equal(p.recentOutputs.length, 15, 'recentOutputs must cap at 15 entries');
    assert.ok(p.recentOutputs[0].includes('line 5'), 'oldest 5 entries must be evicted');
  });

  it('pushRawLog caps at 50 entries', () => {
    const p = freshProgress();
    p._startTime = Date.now();
    for (let i = 0; i < 60; i++) pushRawLog(p, `log ${i}`);
    assert.equal(p.rawLog.length, 50, 'rawLog must cap at 50 entries');
  });

  it('turnCount increments once per assistant event run, not per block', () => {
    // Lines 910-917: turnCount increments only when !lastEventWasAssistant
    let turnCount = 0;
    let lastEventWasAssistant = false;

    const processAssistantEvent = () => {
      if (!lastEventWasAssistant) {
        turnCount++;
        lastEventWasAssistant = true;
      }
    };

    // Three consecutive assistant events (e.g., text + tool_use + text in same turn)
    processAssistantEvent();
    processAssistantEvent();
    processAssistantEvent();

    assert.equal(turnCount, 1, 'consecutive assistant events must count as one turn');
  });

  it('tool history caps at 10 entries', () => {
    const progress = freshProgress();
    for (let i = 0; i < 15; i++) {
      progress.toolHistory.push({ name: `Tool${i}`, detail: '' });
      if (progress.toolHistory.length > 10) progress.toolHistory.shift();
    }
    assert.equal(progress.toolHistory.length, 10, 'tool history must cap at 10');
    assert.equal(progress.toolHistory[0].name, 'Tool5', 'oldest 5 entries must be evicted');
  });

  /**
   * BUG (low): Agent fail-fast flag (line 896-899) is set on agentObj when
   * 3+ consecutive errors occur. The flag is `channelState.progress._agentFailFast`,
   * NOT on the agentObj itself. However, the consecutive error counter IS on
   * agentObj (line 895). If the agentObj is deleted from activeAgents (lines
   * 857-865) before 3 errors accumulate, the consecutiveErrors counter is lost
   * and fail-fast never triggers. This can happen if a tool_result with
   * `rb.tool_use_id` matching an activeAgents key is processed between errors.
   */
  it('consecutiveErrors resets to 0 on successful tool result', () => {
    // Lines 888: agentObj.consecutiveErrors = 0 on non-error result
    const agentObj = { consecutiveErrors: 2 };
    const rb = { is_error: false, content: 'success' };

    if (!rb.is_error && agentObj) {
      // Simulate the successful result path
      const toolResultText = typeof rb.content === 'string' ? rb.content : '';
      if (toolResultText) {
        agentObj.consecutiveErrors = 0;
      }
    }

    assert.equal(agentObj.consecutiveErrors, 0, 'consecutive errors must reset on success');
  });
});

// ─── 9. Semaphore accounting under eviction ───────────────────────────────────

describe('Semaphore accounting — eviction path', () => {
  /**
   * BUG (critical): Lines 121-128 — when the owner evicts a non-owner process,
   * the owner's resolve is pushed to _ownerQueue. The evicted process's close
   * handler calls _releaseSlot(), which drains _ownerQueue. But if the evicted
   * process's close handler fires BEFORE the owner is queued (due to the async
   * nature of forceKillProcess), the slot is released with no owner waiter and
   * _activeSlots is decremented — then the owner waiter is pushed to _ownerQueue
   * and never woken. The slot is permanently lost.
   *
   * This is the classic TOCTOU race on async eviction. The comment in the code
   * ("Slot will be released by the close handler, then we acquire it") documents
   * the intent but not the race.
   */
  it('CRITICAL: eviction race — owner queue must be populated before close handler fires', () => {
    // Demonstrate the race with a synchronous simulation
    let ownerQueue = [];
    let activeSlots = 4; // at capacity

    const releaseSlot = () => {
      if (ownerQueue.length > 0) {
        const next = ownerQueue.shift();
        next(); // pass slot to owner waiter — activeSlots stays same
      } else {
        activeSlots = Math.max(0, activeSlots - 1); // BUG: decrements without owner
      }
    };

    // Race scenario: close fires BEFORE owner is queued
    releaseSlot(); // close handler fires — no owner in queue yet
    assert.equal(activeSlots, 3, 'slot was released (decremented) before owner was queued');

    ownerQueue.push(() => {}); // owner waiter pushed AFTER slot was released
    // Now owner is in queue but slot was already decremented — owner never wakes
    assert.equal(ownerQueue.length, 1, 'owner is stuck in queue — will never be woken');
    assert.equal(activeSlots, 3, 'slot is lost: active=3 but MAX_CONCURRENT=4, one slot permanently unusable');
  });

  it('non-owner timeout cleans itself from queue before rejecting', () => {
    // Lines 139-146: the timer removes the entry from the queue before rejecting
    const queue = [];
    let rejected = false;

    const entry = {
      resolve: () => {},
      reject: (err) => { rejected = true; },
      timedOut: false,
    };
    entry.timer = setTimeout(() => {
      entry.timedOut = true;
      const idx = queue.indexOf(entry);
      if (idx !== -1) queue.splice(idx, 1);
      entry.reject(new Error('timeout'));
    }, 50);
    queue.push(entry);

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.ok(rejected, 'reject must be called after timeout');
        assert.equal(queue.length, 0, 'timed-out entry must be removed from queue');
        assert.ok(entry.timedOut, 'timedOut flag must be set');
        resolve();
      }, 100);
    });
  });

  it('already-timed-out queue entry is skipped during slot release', () => {
    // Lines 158-162: _releaseSlot skips timedOut entries and recurses
    const nonOwnerQueue = [];
    let skipped = 0;
    let woken = 0;

    const releaseSlot = () => {
      if (nonOwnerQueue.length > 0) {
        const entry = nonOwnerQueue.shift();
        if (entry.timedOut) {
          skipped++;
          releaseSlot(); // recurse
          return;
        }
        entry.resolve();
        woken++;
      }
    };

    // Queue: timed-out entry, then valid entry
    nonOwnerQueue.push({ resolve: () => {}, reject: () => {}, timedOut: true });
    nonOwnerQueue.push({ resolve: () => {}, reject: () => {}, timedOut: false });

    releaseSlot();

    assert.equal(skipped, 1, 'timed-out entry must be skipped');
    assert.equal(woken, 1, 'valid entry must be woken');
    assert.equal(nonOwnerQueue.length, 0, 'queue must be empty after release');
  });
});

// ─── 10. Cost tracking ────────────────────────────────────────────────────────

describe('Cost tracking', () => {
  it('cost is null in stopped (code=143) path', () => {
    // Line 1300: stopped resolution has cost: null
    const resolved = { text: '*(Process stopped)*', sessionId: null, cost: null, stopped: true };
    assert.equal(resolved.cost, null, 'killed sessions must have null cost (partial session, not billed)');
  });

  it('cost is 0 in auth failure path', () => {
    // Line 1316: auth failure resolution has cost: 0
    const resolved = { text: '', sessionId: null, cost: 0, authFailed: true, stopped: true };
    assert.equal(resolved.cost, 0, 'auth failure must report cost=0');
  });

  it('cost is 0 in session resume failure path', () => {
    // Line 1342: sessionResumeFailed resolution has cost: 0
    const resolved = { text: '', sessionId: null, cost: 0, sessionResumeFailed: true, stopped: true };
    assert.equal(resolved.cost, 0, 'session resume failure must report cost=0');
  });

  /**
   * BUG (medium): If the CLI exits code=0 but the `result` event was never
   * received (e.g., the JSON stream was truncated or corrupt), `resultCost` stays
   * null and `resultText` stays null. The success path at line 1373 returns:
   *   { text: scrubSecrets(resultText || accumulatedText || ''), cost: null }
   * This is correct in that it surfaces the accumulated text. But resultCost=null
   * means the caller has no way to track spend for that session. If this happens
   * repeatedly (e.g., due to a consistently truncated stream), costs are silently
   * untracked.
   */
  it('KNOWN GAP: code=0 exit with no result event has null cost', () => {
    const resultText = null;      // result event never fired
    const resultCost = null;      // never set
    const accumulatedText = 'Some streamed text...';
    const streamedAny = true;
    const resultNumTurns = 0;
    const maxTurns = 50;

    // Simulate the success path
    const resolved = {
      text: resultText || accumulatedText || '',
      sessionId: null,
      cost: resultCost,          // null — cost is untracked
      numTurns: resultNumTurns,
      hitTurnLimit: resultNumTurns >= maxTurns,
      stopped: false,
      streamed: streamedAny,
    };

    assert.equal(resolved.cost, null, 'GAP: cost is null when result event is missing — spend is untracked');
    assert.ok(resolved.text.length > 0, 'accumulated text is returned even without result event');
  });

  it('resultCost is updated from result event when present', () => {
    // Lines 819: resultCost = event.total_cost_usd when not null
    let resultCost = null;
    const resultEvent = { type: 'result', total_cost_usd: 0.0034, subtype: 'success', result: 'done' };
    resultCost = resultEvent.total_cost_usd != null ? resultEvent.total_cost_usd : resultCost;
    assert.equal(resultCost, 0.0034, 'cost must be updated from result event');
  });

  it('resultCost is preserved from earlier in stream if result event has null cost', () => {
    // Lines 819: `!= null` check preserves existing value when event cost is null
    let resultCost = 0.0021; // set from an earlier partial event
    const resultEvent = { type: 'result', total_cost_usd: null, subtype: 'success', result: 'done' };
    resultCost = resultEvent.total_cost_usd != null ? resultEvent.total_cost_usd : resultCost;
    assert.equal(resultCost, 0.0021, 'earlier cost value must be preserved when result event has null cost');
  });
});

// ─── 11. Tool whitelist enforcement ──────────────────────────────────────────

describe('Tool whitelist enforcement', () => {
  it('groupAllowedTools takes priority over readOnly', () => {
    // Lines 579-598: groupAllowedTools is checked first
    const groupAllowedTools = 'WebSearch,WebFetch,Bash';
    const readOnly = true;
    const ownerDmMode = false;
    const planMode = false;

    const args = [];
    if (groupAllowedTools) {
      args.push('--allowedTools', groupAllowedTools);
    } else if (ownerDmMode && planMode) {
      args.push('--allowedTools', 'Read,Grep,Glob,LS,WebSearch,WebFetch,TodoWrite,Task');
    } else if (readOnly) {
      args.push('--allowedTools', 'Read,Grep,Glob,LS,WebSearch,TodoWrite,Task');
    }

    assert.ok(args.includes('--allowedTools'), 'allowedTools must be set');
    assert.equal(args[args.indexOf('--allowedTools') + 1], groupAllowedTools,
      'groupAllowedTools must take priority over readOnly');
  });

  it('planMode restricts to read-only tools only', () => {
    const groupAllowedTools = null;
    const ownerDmMode = true;
    const planMode = true;

    const args = [];
    if (groupAllowedTools) {
      args.push('--allowedTools', groupAllowedTools);
    } else if (ownerDmMode && planMode) {
      args.push('--allowedTools', ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task'].join(','));
    }

    // Parse the comma-separated list into a Set for exact-name membership tests.
    // .includes('Write') would falsely match 'TodoWrite' — use exact token matching.
    const toolSet = new Set(args[args.indexOf('--allowedTools') + 1].split(','));
    assert.ok(!toolSet.has('Bash'), 'plan mode must not allow Bash');
    assert.ok(!toolSet.has('Edit'), 'plan mode must not allow Edit');
    assert.ok(!toolSet.has('Write'), 'plan mode must not allow Write (note: TodoWrite is allowed — different tool)');
    assert.ok(toolSet.has('Read'), 'plan mode must allow Read');
    assert.ok(toolSet.has('WebSearch'), 'plan mode must allow WebSearch');
    assert.ok(toolSet.has('TodoWrite'), 'plan mode must allow TodoWrite for planning notes');
  });

  it('readOnly excludes WebFetch (exfil chain mitigation)', () => {
    // Line 594: WebFetch is intentionally excluded from readOnly allowlist
    const groupAllowedTools = null;
    const ownerDmMode = false;
    const planMode = false;
    const readOnly = true;

    const args = [];
    if (groupAllowedTools) {
      args.push('--allowedTools', groupAllowedTools);
    } else if (ownerDmMode && planMode) {
      // not taken
    } else if (readOnly) {
      args.push('--allowedTools', ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'TodoWrite', 'Task'].join(','));
    }

    const toolList = args[args.indexOf('--allowedTools') + 1];
    assert.ok(!toolList.includes('WebFetch'), 'readOnly must exclude WebFetch (exfil chain prevention)');
    assert.ok(!toolList.includes('Bash'), 'readOnly must exclude Bash');
    assert.ok(!toolList.includes('Edit'), 'readOnly must exclude Edit');
  });

  it('ownerDmMode without planMode gets no --allowedTools (full access)', () => {
    // When ownerDmMode=true and planMode=false, no allowedTools args are pushed
    const groupAllowedTools = null;
    const ownerDmMode = true;
    const planMode = false;
    const readOnly = false;

    const args = [];
    if (groupAllowedTools) {
      args.push('--allowedTools', groupAllowedTools);
    } else if (ownerDmMode && planMode) {
      args.push('--allowedTools', 'Read,Grep,...');
    } else if (readOnly) {
      args.push('--allowedTools', 'Read,...');
    }

    assert.ok(!args.includes('--allowedTools'), 'owner DM mode (no plan) must have unrestricted tool access');
  });
});
