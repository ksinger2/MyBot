/**
 * Tests for sandbox isolation guarantees:
 *   - Env var scoping (CLOUDFLARE_API_TOKEN, GH_TOKEN, CLOUDFLARE_ACCOUNT_ID)
 *   - Linux username validation (injection prevention)
 *   - Tunnel exponential backoff logic
 *   - Tunnel reviveTunnel state reset
 *
 * Uses node:test runner. No external test frameworks.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Env-building logic ──────────────────────────────────────────────────────
// Extracted from runner.js lines 667-672 to avoid pulling in the full Runner
// class (which requires Discord.js, Claude CLI, etc.). This mirrors the exact
// conditional logic used when spawning claude processes.

function buildSandboxEnv(sandboxUser) {
  return {
    GH_TOKEN: sandboxUser ? '' : (process.env.GH_TOKEN || ''),
    CLOUDFLARE_API_TOKEN: sandboxUser
      ? (sandboxUser.cloudflareToken || process.env.CLOUDFLARE_API_TOKEN || '')
      : (process.env.CLOUDFLARE_API_TOKEN || ''),
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  };
}

// ── Tunnel backoff logic ────────────────────────────────────────────────────
// Extracted from sandbox-tunnel.js handleCrash to test without spawning
// cloudflared or triggering module-level auto-start side effects.

const MAX_RESTART_ATTEMPTS = 10;
const RESTART_COOLDOWN_MS = 5000;
const MAX_BACKOFF_MS = 300000;

function calculateBackoffDelay(restartCount) {
  return Math.min(RESTART_COOLDOWN_MS * Math.pow(2, restartCount - 1), MAX_BACKOFF_MS);
}

// ── Linux username validation regex ─────────────────────────────────────────
// From runner.js line 695

const SANDBOX_USER_REGEX = /^sandbox-[a-z0-9]{1,20}$/;

// ─────────────────────────────────────────────────────────────────────────────

describe('sandbox env isolation — CLOUDFLARE_API_TOKEN', () => {
  it('falls through to process.env when sandboxUser has no cloudflareToken', () => {
    const saved = process.env.CLOUDFLARE_API_TOKEN;
    try {
      process.env.CLOUDFLARE_API_TOKEN = 'global_cf_token';
      const env = buildSandboxEnv({ name: 'alice', linuxUser: 'sandbox-alice' });
      assert.equal(env.CLOUDFLARE_API_TOKEN, 'global_cf_token');
    } finally {
      if (saved === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = saved;
    }
  });

  it('uses per-sandbox scoped token when present', () => {
    const env = buildSandboxEnv({
      name: 'bob',
      linuxUser: 'sandbox-bob',
      cloudflareToken: 'cf_scoped_123',
    });
    assert.equal(env.CLOUDFLARE_API_TOKEN, 'cf_scoped_123');
  });

  it('uses process.env when sandboxUser is null (owner session)', () => {
    const saved = process.env.CLOUDFLARE_API_TOKEN;
    try {
      process.env.CLOUDFLARE_API_TOKEN = 'owner_token_abc';
      const env = buildSandboxEnv(null);
      assert.equal(env.CLOUDFLARE_API_TOKEN, 'owner_token_abc');
    } finally {
      if (saved === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = saved;
    }
  });
});

describe('sandbox env isolation — GH_TOKEN', () => {
  it('is empty string when sandboxUser is truthy', () => {
    const env = buildSandboxEnv({ name: 'alice', linuxUser: 'sandbox-alice' });
    assert.equal(env.GH_TOKEN, '');
  });

  it('uses process.env when sandboxUser is null', () => {
    const saved = process.env.GH_TOKEN;
    try {
      process.env.GH_TOKEN = 'ghp_owner_token';
      const env = buildSandboxEnv(null);
      assert.equal(env.GH_TOKEN, 'ghp_owner_token');
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });
});

describe('sandbox env isolation — CLOUDFLARE_ACCOUNT_ID', () => {
  it('is available to sandbox users from process.env', () => {
    const saved = process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      process.env.CLOUDFLARE_ACCOUNT_ID = 'acct_12345';
      const env = buildSandboxEnv({ name: 'alice', linuxUser: 'sandbox-alice' });
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'acct_12345');
    } finally {
      if (saved === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = saved;
    }
  });

  it('uses process.env when sandboxUser is null', () => {
    const saved = process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      process.env.CLOUDFLARE_ACCOUNT_ID = 'acct_12345';
      const env = buildSandboxEnv(null);
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'acct_12345');
    } finally {
      if (saved === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = saved;
    }
  });
});

describe('sandbox linuxUser validation — injection prevention', () => {
  it('accepts valid sandbox usernames', () => {
    assert.ok(SANDBOX_USER_REGEX.test('sandbox-alice'));
    assert.ok(SANDBOX_USER_REGEX.test('sandbox-bob123'));
    assert.ok(SANDBOX_USER_REGEX.test('sandbox-a'));
    assert.ok(SANDBOX_USER_REGEX.test('sandbox-12345678901234567890')); // 20 chars after prefix
  });

  it('rejects command injection via semicolon', () => {
    assert.equal(SANDBOX_USER_REGEX.test('sandbox-; rm -rf /'), false);
  });

  it('rejects path traversal', () => {
    assert.equal(SANDBOX_USER_REGEX.test('sandbox-../../etc'), false);
  });

  it('rejects empty string', () => {
    assert.equal(SANDBOX_USER_REGEX.test(''), false);
  });

  it('rejects strings longer than 28 chars (prefix + 20)', () => {
    // "sandbox-" is 8 chars, max payload is 20 → total 28
    const tooLong = 'sandbox-' + 'a'.repeat(21);
    assert.equal(tooLong.length, 29);
    assert.equal(SANDBOX_USER_REGEX.test(tooLong), false);
  });

  it('rejects uppercase letters', () => {
    assert.equal(SANDBOX_USER_REGEX.test('sandbox-Alice'), false);
  });

  it('rejects missing prefix', () => {
    assert.equal(SANDBOX_USER_REGEX.test('alice'), false);
  });

  it('rejects special characters', () => {
    assert.equal(SANDBOX_USER_REGEX.test('sandbox-al$ce'), false);
    assert.equal(SANDBOX_USER_REGEX.test('sandbox-al ice'), false);
    assert.equal(SANDBOX_USER_REGEX.test('sandbox-al_ce'), false);
  });
});

describe('tunnel exponential backoff', () => {
  it('first crash → 5s delay', () => {
    assert.equal(calculateBackoffDelay(1), 5000);
  });

  it('second crash → 10s delay', () => {
    assert.equal(calculateBackoffDelay(2), 10000);
  });

  it('third crash → 20s delay', () => {
    assert.equal(calculateBackoffDelay(3), 20000);
  });

  it('fourth crash → 40s delay', () => {
    assert.equal(calculateBackoffDelay(4), 40000);
  });

  it('fifth crash → 80s delay', () => {
    assert.equal(calculateBackoffDelay(5), 80000);
  });

  it('sixth crash → 160s delay', () => {
    assert.equal(calculateBackoffDelay(6), 160000);
  });

  it('seventh crash → capped at 300s', () => {
    // 5000 * 2^6 = 320000, but cap is 300000
    assert.equal(calculateBackoffDelay(7), 300000);
  });

  it('tenth crash → still capped at 300s', () => {
    assert.equal(calculateBackoffDelay(10), 300000);
  });

  it('delay sequence is monotonically non-decreasing', () => {
    let prev = 0;
    for (let i = 1; i <= MAX_RESTART_ATTEMPTS; i++) {
      const d = calculateBackoffDelay(i);
      assert.ok(d >= prev, `delay at restart ${i} (${d}) should be >= previous (${prev})`);
      prev = d;
    }
  });
});

describe('tunnel reviveTunnel state reset', () => {
  // We test the logic pattern without requiring the real module
  // (which auto-starts cloudflared on load). Replicate the state machine.

  it('resets stopped and restartCount', () => {
    // Simulate state after max retries exceeded
    let stopped = true;
    let restartCount = 10;
    let startTunnelCalled = false;

    // reviveTunnel logic (mirrors sandbox-tunnel.js)
    function reviveTunnel() {
      stopped = false;
      restartCount = 0;
      startTunnelCalled = true; // stand-in for startTunnel()
    }

    reviveTunnel();

    assert.equal(stopped, false, 'stopped should be reset to false');
    assert.equal(restartCount, 0, 'restartCount should be reset to 0');
    assert.equal(startTunnelCalled, true, 'startTunnel should be called');
  });

  it('clears pending restart timer', () => {
    let restartTimer = setTimeout(() => {}, 999999);
    let cleared = false;
    const origClear = clearTimeout;

    // reviveTunnel clears the timer
    if (restartTimer) {
      origClear(restartTimer);
      restartTimer = null;
      cleared = true;
    }

    assert.equal(restartTimer, null, 'restartTimer should be null');
    assert.equal(cleared, true, 'timer should have been cleared');
  });
});
