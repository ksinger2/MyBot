/**
 * Tests for safeTokenEqual() in server.js and the scrubSecrets() function in runner.js.
 *
 * safeTokenEqual is not exported, so we test it by extracting the logic.
 * scrubSecrets IS exported — we test it directly.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ── Replicate safeTokenEqual exactly as implemented in server.js ─────────────
// (server.js can't be required in tests without full Express/Discord startup)
function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  Buffer.from(a).copy(bufA);
  Buffer.from(b).copy(bufB);
  return a.length === b.length && crypto.timingSafeEqual(bufA, bufB);
}

describe('safeTokenEqual (server.js timing-safe compare)', () => {
  it('returns true for equal tokens', () => {
    assert.equal(safeTokenEqual('abc123xyz', 'abc123xyz'), true);
  });

  it('returns false for different tokens of same length', () => {
    assert.equal(safeTokenEqual('abc123xyz', 'abc123XYZ'), false);
  });

  it('returns false for tokens of different lengths', () => {
    assert.equal(safeTokenEqual('short', 'muchlongertoken'), false);
  });

  it('returns false for empty string a', () => {
    assert.equal(safeTokenEqual('', 'sometoken'), false);
  });

  it('returns false for empty string b', () => {
    assert.equal(safeTokenEqual('sometoken', ''), false);
  });

  it('returns false for both empty strings', () => {
    assert.equal(safeTokenEqual('', ''), false);
  });

  it('returns false when a is not a string', () => {
    assert.equal(safeTokenEqual(null, 'token'), false);
    assert.equal(safeTokenEqual(123, 'token'), false);
    assert.equal(safeTokenEqual(undefined, 'token'), false);
  });

  it('returns false when b is not a string', () => {
    assert.equal(safeTokenEqual('token', null), false);
    assert.equal(safeTokenEqual('token', 123), false);
  });

  it('pads to equal length before comparing — timingSafeEqual always runs', () => {
    // When a is longer: bufA = [a..., 0..0], bufB = [b..., 0..0]
    // a.length !== b.length so returns false, but timingSafeEqual ran on equal-sized buffers.
    // This is the key property: no short-circuit on length mismatch (unlike the _tryUnlock bug).
    // We verify by checking that a token that happens to be a prefix of another still returns false.
    assert.equal(safeTokenEqual('abc', 'abcdef'), false);
    assert.equal(safeTokenEqual('abcdef', 'abc'), false);
  });

  it('handles long tokens (JWT-length)', () => {
    const longToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    assert.equal(safeTokenEqual(longToken, longToken), true);
    assert.equal(safeTokenEqual(longToken, longToken + 'x'), false);
  });
});

// ── scrubSecrets tests ─────────────────────────────────────────────────────
// Stub the internal-token dependency so runner.js loads cleanly in test context.
const fakeTokenPath = require.resolve('../internal-token');
if (!require.cache[fakeTokenPath]) {
  require.cache[fakeTokenPath] = {
    id: fakeTokenPath, filename: fakeTokenPath, loaded: true,
    exports: { getInternalToken: () => 'test-internal-token-value-here' },
  };
}
delete require.cache[require.resolve('../runner')];
const { scrubSecrets } = require('../runner');

describe('scrubSecrets (runner.js output sanitizer)', () => {
  it('redacts Bearer tokens', () => {
    const text = 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.longtoken.sig" https://api.example.com';
    const out = scrubSecrets(text);
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'Bearer JWT should be redacted');
    assert.ok(out.includes('Bearer [REDACTED]'));
  });

  it('redacts sk- prefixed OpenAI keys', () => {
    // Test the sk- pattern directly (without a _KEY= wrapper that the generic rule catches first)
    const text = 'Using key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 for auth';
    const out = scrubSecrets(text);
    assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'), 'sk- key should be redacted');
    assert.ok(out.includes('sk-[REDACTED]'));
  });

  it('redacts Stripe sk_live keys', () => {
    const text = 'key: sk_live_' + 'x'.repeat(30);
    const out = scrubSecrets(text);
    assert.ok(out.includes('[REDACTED]'));
  });

  it('redacts GitHub classic PATs (ghp_)', () => {
    const text = 'token=ghp_abcdefghijklmnopqrstuvwxyz123456';
    const out = scrubSecrets(text);
    assert.ok(out.includes('ghp_[REDACTED]'));
    assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'));
  });

  it('redacts GitHub fine-grained PATs (github_pat_)', () => {
    // Test the github_pat_ pattern directly without GH_TOKEN= prefix (which fires first via _TOKEN= rule)
    const text = 'token is github_pat_11ABCDEFGHIJKLMNOPQRSTUVWX in the config';
    const out = scrubSecrets(text);
    assert.ok(out.includes('github_pat_[REDACTED]'));
    assert.ok(!out.includes('11ABCDEFGHIJKLMNOPQRSTUVWX'));
  });

  it('redacts Replicate tokens (r8_)', () => {
    const text = 'replicate.run(r8_abcdefghijklmnopqrstuvwxyz12345)';
    const out = scrubSecrets(text);
    assert.ok(out.includes('r8_[REDACTED]'));
  });

  it('redacts Google/Gemini API keys (AIzaSy)', () => {
    // Test the AIzaSy pattern directly without a _key= prefix (which triggers generic rule first)
    const text = 'Configured with AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz1234567 as the key';
    const out = scrubSecrets(text);
    assert.ok(out.includes('AIzaSy[REDACTED]'));
    assert.ok(!out.includes('AbCdEfGhIjKlMnOpQrStUvWxYz'));
  });

  it('redacts environment variable dump lines (known names)', () => {
    const text = 'DISCORD_BOT_TOKEN=MTIzNDU2Nzg5LongDiscordToken.here\nNODE_ENV=production';
    const out = scrubSecrets(text);
    assert.ok(out.includes('DISCORD_BOT_TOKEN=[REDACTED]'), 'Known env var should be redacted');
    assert.ok(out.includes('NODE_ENV=production'), 'Non-secret env var should be preserved');
  });

  it('redacts generic _KEY, _TOKEN, _SECRET, _PASSWORD suffixed env vars', () => {
    const text = 'MY_CUSTOM_API_KEY=supersecretvaluehere\nMY_AUTH_TOKEN=anothertoken123456';
    const out = scrubSecrets(text);
    assert.ok(out.includes('MY_CUSTOM_API_KEY=[REDACTED]'));
    assert.ok(out.includes('MY_AUTH_TOKEN=[REDACTED]'));
  });

  it('redacts JSON values for known secret key names', () => {
    const text = '{"OPENAI_API_KEY": "sk-abc123def456ghi789", "status": "ok"}';
    const out = scrubSecrets(text);
    assert.ok(out.includes('"OPENAI_API_KEY": "[REDACTED]"'));
    assert.ok(out.includes('"status": "ok"'));
  });

  it('redacts generic JSON secret keys with 8+ char values', () => {
    const text = '{"api_key": "verylongsecretvalue", "name": "safe"}';
    const out = scrubSecrets(text);
    assert.ok(!out.includes('verylongsecretvalue'));
    assert.ok(out.includes('"name": "safe"'));
  });

  it('does NOT redact generic JSON values shorter than 8 chars (false positive prevention)', () => {
    const text = '{"token": "short"}';
    const out = scrubSecrets(text);
    assert.ok(out.includes('"token": "short"'), 'Short values should not be redacted');
  });

  it('redacts Basic auth headers', () => {
    const text = 'Authorization: Basic dXNlcjpwYXNzd29yZA==longvalue';
    const out = scrubSecrets(text);
    assert.ok(out.includes('Authorization: Basic [REDACTED]'));
  });

  it('redacts X-Internal-Token headers', () => {
    const text = 'X-Internal-Token: my-secret-internal-token-value';
    const out = scrubSecrets(text);
    assert.ok(out.includes('X-Internal-Token: [REDACTED]'));
    assert.ok(!out.includes('my-secret-internal-token-value'));
  });

  it('redacts password fields', () => {
    const text = 'password: supersecretpassword123';
    const out = scrubSecrets(text);
    assert.ok(out.includes('password=[REDACTED]'));
  });

  it('preserves normal code output unchanged', () => {
    const inputs = [
      'Build succeeded in 2.4s',
      'Running tests... 47 passed',
      'File saved to /app/src/index.js',
      '{"status": "ok", "count": 42}',
      'node version: v18.17.0',
    ];
    for (const input of inputs) {
      const out = scrubSecrets(input);
      assert.equal(out, input, `Normal text should not be modified: ${input}`);
    }
  });

  it('returns non-string input unchanged', () => {
    assert.equal(scrubSecrets(null), null);
    assert.equal(scrubSecrets(42), 42);
    assert.equal(scrubSecrets(undefined), undefined);
  });

  it('handles empty string', () => {
    assert.equal(scrubSecrets(''), '');
  });
});
