const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEST_DIR = path.join('/tmp', `encrypted-json-test-${process.pid}`);
const TEST_FILE = path.join(TEST_DIR, 'test-store.json');

// Generate a stable test key (not a real secret — test-only)
const TEST_KEY = 'test-encryption-key-for-unit-tests-only';

describe('encrypted-json', () => {
  let readEncryptedJson, writeEncryptedJson;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // Set TOKEN_ENCRYPTION_KEY for tests
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    // Clear require cache so the module picks up the env var
    delete require.cache[require.resolve('../encrypted-json')];
    ({ readEncryptedJson, writeEncryptedJson } = require('../encrypted-json'));
    // Clear warning caches between test runs
    readEncryptedJson._warned = null;
    writeEncryptedJson._warned = null;
  });

  after(() => {
    // Clean up test files
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('roundtrip: write encrypted then read back', () => {
    const data = {
      version: 2,
      byUuid: { 'abc-123': { phone: '+15551234567', firstSeen: 1000, lastSeen: 2000 } },
      byPhone: { '+15551234567': ['abc-123'] },
    };

    writeEncryptedJson(TEST_FILE, data, 'test-roundtrip');
    const result = readEncryptedJson(TEST_FILE, 'test-roundtrip');

    assert.deepStrictEqual(result, data);

    // Verify the file on disk is NOT plaintext
    const raw = fs.readFileSync(TEST_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.v, 1, 'On-disk format should be an encrypted envelope');
    assert.ok(parsed.iv, 'Envelope should have iv');
    assert.ok(parsed.tag, 'Envelope should have tag');
    assert.ok(parsed.ct, 'Envelope should have ct');
    // Phone number should not appear in ciphertext
    assert.ok(!raw.includes('+15551234567'), 'Phone number must not appear in encrypted file');
  });

  it('auto-migration: plaintext file is readable, next write encrypts', () => {
    const plainFile = path.join(TEST_DIR, 'plaintext-migration.json');
    const data = { members: ['+15559876543', '+15551111111'] };

    // Write plaintext directly (simulating a legacy file)
    fs.writeFileSync(plainFile, JSON.stringify(data, null, 2));

    // Read should return the data as-is
    const result = readEncryptedJson(plainFile, 'test-migration');
    assert.deepStrictEqual(result, data);

    // Now write it back (should encrypt)
    writeEncryptedJson(plainFile, data, 'test-migration');

    // Verify it's now encrypted on disk
    const raw = fs.readFileSync(plainFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.v, 1, 'Should be encrypted after write');
    assert.ok(!raw.includes('+15559876543'), 'Phone should not appear in encrypted file');

    // And still readable
    const result2 = readEncryptedJson(plainFile, 'test-migration');
    assert.deepStrictEqual(result2, data);
  });

  it('different domains produce different ciphertext', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const fileA = path.join(TEST_DIR, 'domain-a.json');
    const fileB = path.join(TEST_DIR, 'domain-b.json');
    const data = { secret: 'same-data-different-domains' };

    writeEncryptedJson(fileA, data, 'domain-alpha');
    writeEncryptedJson(fileB, data, 'domain-beta');

    const rawA = JSON.parse(fs.readFileSync(fileA, 'utf8'));
    const rawB = JSON.parse(fs.readFileSync(fileB, 'utf8'));

    // Both should be encrypted envelopes
    assert.equal(rawA.v, 1);
    assert.equal(rawB.v, 1);

    // Ciphertext should differ (different derived keys + different IVs)
    assert.notEqual(rawA.ct, rawB.ct, 'Different domains must produce different ciphertext');

    // Cross-domain read should fail (wrong key) — returns empty object
    const crossRead = readEncryptedJson(fileA, 'domain-beta');
    assert.deepStrictEqual(crossRead, {}, 'Cross-domain decryption should return empty object');
  });

  it('missing file returns empty object', () => {
    const result = readEncryptedJson(path.join(TEST_DIR, 'nonexistent.json'), 'test-missing');
    assert.deepStrictEqual(result, {});
  });

  it('missing TOKEN_ENCRYPTION_KEY falls back to plaintext with warning', () => {
    const noKeyFile = path.join(TEST_DIR, 'no-key.json');
    const data = { users: ['+15550000000'] };

    // Save and clear the key
    const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    // Re-require to pick up missing key
    delete require.cache[require.resolve('../encrypted-json')];
    const noKey = require('../encrypted-json');
    noKey.readEncryptedJson._warned = null;
    noKey.writeEncryptedJson._warned = null;

    // Capture console warnings
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      noKey.writeEncryptedJson(noKeyFile, data, 'test-no-key');

      // File should be plaintext
      const raw = fs.readFileSync(noKeyFile, 'utf8');
      assert.ok(raw.includes('+15550000000'), 'Without key, data should be plaintext');

      // Read should work
      const result = noKey.readEncryptedJson(noKeyFile, 'test-no-key');
      assert.deepStrictEqual(result, data);

      // Should have emitted warnings
      assert.ok(warnings.some(w => w.includes('TOKEN_ENCRYPTION_KEY not set')),
        'Should warn about missing encryption key');
    } finally {
      console.warn = origWarn;
      // Restore key
      process.env.TOKEN_ENCRYPTION_KEY = savedKey;
      delete require.cache[require.resolve('../encrypted-json')];
    }
  });

  it('handles array data (known-group-members format)', () => {
    const arrFile = path.join(TEST_DIR, 'array-data.json');
    const data = { members: ['+15551111111', '+15552222222', 'uuid-abc-123'] };

    writeEncryptedJson(arrFile, data, 'test-array');
    const result = readEncryptedJson(arrFile, 'test-array');
    assert.deepStrictEqual(result, data);
  });

  it('handles empty object gracefully', () => {
    const emptyFile = path.join(TEST_DIR, 'empty-obj.json');
    writeEncryptedJson(emptyFile, {}, 'test-empty');
    const result = readEncryptedJson(emptyFile, 'test-empty');
    assert.deepStrictEqual(result, {});
  });

  it('envelope format matches { v: 1, iv, tag, ct } spec', () => {
    const specFile = path.join(TEST_DIR, 'spec-check.json');
    writeEncryptedJson(specFile, { test: true }, 'test-spec');

    const envelope = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    assert.equal(envelope.v, 1);
    assert.equal(typeof envelope.iv, 'string');
    assert.equal(typeof envelope.tag, 'string');
    assert.equal(typeof envelope.ct, 'string');
    // IV should be 12 bytes = 24 hex chars
    assert.equal(envelope.iv.length, 24, 'IV should be 12 bytes (24 hex chars)');
    // Auth tag should be 16 bytes = 32 hex chars
    assert.equal(envelope.tag.length, 32, 'Auth tag should be 16 bytes (32 hex chars)');
    // Only these four keys should exist
    assert.deepStrictEqual(Object.keys(envelope).sort(), ['ct', 'iv', 'tag', 'v']);
  });
});
