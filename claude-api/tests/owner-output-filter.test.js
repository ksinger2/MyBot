const { describe, it } = require('node:test');
const assert = require('node:assert');

// Stub internal-token before requiring owner-output-filter (which requires runner.js)
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === './internal-token' || request.endsWith('/internal-token')) {
    // Return a fake module path — we'll intercept require below
  }
  return originalResolve.call(this, request, parent, ...rest);
};
// Pre-populate the require cache with a stub for internal-token
const fakeTokenPath = require.resolve('../internal-token').replace(/internal-token\.js$/, 'internal-token.js');
require.cache[fakeTokenPath] = {
  id: fakeTokenPath,
  filename: fakeTokenPath,
  loaded: true,
  exports: { getInternalToken: () => 'test-token-short' },
};

const { filterOwnerOutput } = require('../owner-output-filter');

describe('owner-output-filter', () => {
  it('redacts JSON-formatted secrets with known env var names', () => {
    const input = 'Config: {"OPENAI_API_KEY": "sk-abc123xyz789longvalue", "other": "safe"}';
    const { text, redactions } = filterOwnerOutput(input);
    assert.ok(!text.includes('sk-abc123xyz789longvalue'), 'API key value should be redacted');
    assert.ok(text.includes('"OPENAI_API_KEY": "[REDACTED]"'), 'Key name should remain with [REDACTED] value');
    assert.ok(text.includes('"other": "safe"'), 'Non-secret keys should be preserved');
    assert.ok(redactions.length > 0, 'Should have at least one redaction');
  });

  it('redacts generic JSON secret keys (api_key, token, password, etc.)', () => {
    const input = '{"api_key": "supersecretvalue123", "token": "longtokenvalue99", "name": "safe"}';
    const { text, redactions } = filterOwnerOutput(input);
    assert.ok(!text.includes('supersecretvalue123'));
    assert.ok(!text.includes('longtokenvalue99'));
    assert.ok(text.includes('"name": "safe"'));
    assert.ok(redactions.length > 0);
  });

  it('does not redact short generic JSON values (< 8 chars)', () => {
    const input = '{"token": "short", "name": "safe"}';
    const { text } = filterOwnerOutput(input);
    // "short" is only 5 chars — should not be redacted by the generic rule
    assert.ok(text.includes('"token": "short"'));
  });

  it('redacts env variable dump lines', () => {
    const input = 'Here is the env:\nexport DISCORD_BOT_TOKEN=MTIzNDU2Nzg5.long.token.here\nOPENAI_API_KEY=sk-verylongapikey123\nNODE_ENV=production';
    const { text, redactions } = filterOwnerOutput(input);
    assert.ok(!text.includes('MTIzNDU2Nzg5'));
    assert.ok(!text.includes('sk-verylongapikey123'));
    assert.ok(text.includes('DISCORD_BOT_TOKEN=[REDACTED]'));
    assert.ok(text.includes('OPENAI_API_KEY=[REDACTED]'));
    // NODE_ENV is not a known secret name — should be preserved
    assert.ok(text.includes('NODE_ENV=production'));
    assert.ok(redactions.some(r => r.startsWith('env-dump:')));
  });

  it('redacts sensitive file paths', () => {
    const input = 'I found the config at /app/data/.env and also /home/node/credentials.json is readable.';
    const { text, redactions } = filterOwnerOutput(input);
    assert.ok(!text.includes('/app/data/.env'));
    assert.ok(!text.includes('/home/node/credentials.json'));
    assert.ok(text.includes('[sensitive-file-redacted]'));
    assert.ok(redactions.some(r => r.startsWith('sensitive-path:')));
  });

  it('redacts phone numbers with middle digits masked', () => {
    const input = 'Call Karen at +14155551234 for help.';
    const { text, redactions } = filterOwnerOutput(input);
    assert.ok(!text.includes('+14155551234'), 'Full phone number should not appear');
    // Should contain masked version: first 3 digits + asterisks + last 2 digits
    assert.ok(text.includes('141*****34') || text.match(/\d{3}\*+\d{2}/), 'Should have masked phone');
    assert.ok(redactions.some(r => r.startsWith('phone:')));
  });

  it('preserves normal text unchanged', () => {
    const input = 'The build succeeded! All 47 tests pass and the Docker image is 312MB.';
    const { text, redactions } = filterOwnerOutput(input);
    assert.strictEqual(text, input);
    assert.strictEqual(redactions.length, 0);
  });

  it('handles empty/null input gracefully', () => {
    assert.deepStrictEqual(filterOwnerOutput(''), { text: '', redactions: [] });
    assert.deepStrictEqual(filterOwnerOutput(null), { text: '', redactions: [] });
    assert.deepStrictEqual(filterOwnerOutput(undefined), { text: '', redactions: [] });
  });

  it('redacts Bearer tokens and sk- prefixed keys', () => {
    const input = 'Use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.long.token and sk-proj-abcdefghijklmnopqrst for auth.';
    const { text } = filterOwnerOutput(input);
    assert.ok(!text.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
    assert.ok(!text.includes('sk-proj-abcdefghijklmnopqrst'));
    assert.ok(text.includes('Bearer [REDACTED]'));
    assert.ok(text.includes('sk-[REDACTED]'));
  });

  it('redacts .env.production and .env.local file paths', () => {
    const input = 'Check /app/.env.production for the keys.';
    const { text, redactions } = filterOwnerOutput(input);
    assert.ok(!text.includes('.env.production'));
    assert.ok(text.includes('[sensitive-file-redacted]'));
    assert.ok(redactions.some(r => r.includes('.env.production')));
  });
});
