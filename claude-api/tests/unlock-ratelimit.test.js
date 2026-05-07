const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkLockout,
  recordFailure,
  clearAttempts,
  UNLOCK_MAX_ATTEMPTS,
  UNLOCK_LOCKOUT_MS,
  _getAttempts,
  _reset,
} = require('../unlock-ratelimit');

describe('Unlock rate limiter', () => {
  beforeEach(() => {
    _reset();
  });

  it('returns null when no attempts recorded', () => {
    assert.equal(checkLockout('ch-1'), null);
  });

  it('records failures and increments count', () => {
    const r1 = recordFailure('ch-1');
    assert.equal(r1.count, 1);
    assert.equal(r1.max, UNLOCK_MAX_ATTEMPTS);

    const r2 = recordFailure('ch-1');
    assert.equal(r2.count, 2);
  });

  it('does not lock out before max attempts', () => {
    for (let i = 0; i < UNLOCK_MAX_ATTEMPTS - 1; i++) {
      recordFailure('ch-1');
    }
    assert.equal(checkLockout('ch-1'), null);
  });

  it('locks out after max attempts', () => {
    for (let i = 0; i < UNLOCK_MAX_ATTEMPTS; i++) {
      recordFailure('ch-1');
    }
    const lockout = checkLockout('ch-1');
    assert.ok(lockout, 'should be locked out');
    assert.equal(lockout.locked, true);
    assert.ok(lockout.remainMs > 0);
    assert.ok(lockout.remainMs <= UNLOCK_LOCKOUT_MS);
  });

  it('clearAttempts resets the counter', () => {
    for (let i = 0; i < UNLOCK_MAX_ATTEMPTS; i++) {
      recordFailure('ch-1');
    }
    clearAttempts('ch-1');
    assert.equal(_getAttempts('ch-1'), null);
    assert.equal(checkLockout('ch-1'), null);
  });

  it('tracks channels independently', () => {
    for (let i = 0; i < UNLOCK_MAX_ATTEMPTS; i++) {
      recordFailure('ch-1');
    }
    // ch-2 should not be affected
    assert.equal(checkLockout('ch-2'), null);
    recordFailure('ch-2');
    assert.equal(_getAttempts('ch-2').count, 1);
  });

  it('lockout expires after the window', () => {
    // Manually set an expired entry
    recordFailure('ch-1');
    const entry = _getAttempts('ch-1');
    // Simulate the entry being old enough to expire
    entry.count = UNLOCK_MAX_ATTEMPTS;
    entry.lastAttempt = Date.now() - UNLOCK_LOCKOUT_MS - 1;

    const lockout = checkLockout('ch-1');
    assert.equal(lockout, null, 'expired lockout should return null');
    // Entry should be cleaned up
    assert.equal(_getAttempts('ch-1'), null);
  });

  it('sub-max attempts also reset after window expires', () => {
    recordFailure('ch-1');
    recordFailure('ch-1');
    const entry = _getAttempts('ch-1');
    entry.lastAttempt = Date.now() - UNLOCK_LOCKOUT_MS - 1;

    // checkLockout resets expired entries even if under max
    const lockout = checkLockout('ch-1');
    assert.equal(lockout, null);
    assert.equal(_getAttempts('ch-1'), null);
  });
});
