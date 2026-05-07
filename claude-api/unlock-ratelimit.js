/**
 * Brute-force protection for the !unlock PIN gate.
 *
 * Tracks failed attempts per channel. After UNLOCK_MAX_ATTEMPTS failures
 * within the UNLOCK_LOCKOUT_MS window, further attempts are rejected
 * until the lockout expires.
 */

const _unlockAttempts = new Map(); // channelId -> { count, lastAttempt }
const UNLOCK_MAX_ATTEMPTS = 5;
const UNLOCK_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Check whether a channel is currently locked out.
 * If the lockout window has expired, resets the counter and returns null.
 * @param {string} channelId
 * @returns {{ locked: true, remainMs: number } | null}
 */
function checkLockout(channelId) {
  const now = Date.now();
  const entry = _unlockAttempts.get(channelId);
  if (!entry) return null;

  if (now - entry.lastAttempt >= UNLOCK_LOCKOUT_MS) {
    // Lockout window expired — reset
    _unlockAttempts.delete(channelId);
    return null;
  }

  if (entry.count >= UNLOCK_MAX_ATTEMPTS) {
    const remainMs = UNLOCK_LOCKOUT_MS - (now - entry.lastAttempt);
    return { locked: true, remainMs };
  }

  return null;
}

/**
 * Record a failed PIN attempt for the given channel.
 * @param {string} channelId
 * @returns {{ count: number, max: number }}
 */
function recordFailure(channelId) {
  const now = Date.now();
  const entry = _unlockAttempts.get(channelId);
  if (entry) {
    entry.count += 1;
    entry.lastAttempt = now;
  } else {
    _unlockAttempts.set(channelId, { count: 1, lastAttempt: now });
  }
  const current = _unlockAttempts.get(channelId);
  return { count: current.count, max: UNLOCK_MAX_ATTEMPTS };
}

/**
 * Clear attempt tracking for a channel (call on successful unlock).
 * @param {string} channelId
 */
function clearAttempts(channelId) {
  _unlockAttempts.delete(channelId);
}

/**
 * Expose internals for testing only.
 */
function _getAttempts(channelId) {
  return _unlockAttempts.get(channelId) || null;
}

function _reset() {
  _unlockAttempts.clear();
}

// Periodic cleanup: sweep expired entries every 10 minutes
const _sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [channelId, entry] of _unlockAttempts) {
    if (now - entry.lastAttempt >= UNLOCK_LOCKOUT_MS) {
      _unlockAttempts.delete(channelId);
    }
  }
}, 10 * 60 * 1000);
_sweepInterval.unref();

module.exports = {
  checkLockout,
  recordFailure,
  clearAttempts,
  UNLOCK_MAX_ATTEMPTS,
  UNLOCK_LOCKOUT_MS,
  // Test helpers
  _getAttempts,
  _reset,
};
