/**
 * Encrypted JSON file I/O — reusable wrapper for any JSON file that should be
 * encrypted at rest with AES-256-GCM using TOKEN_ENCRYPTION_KEY.
 *
 * Uses the same envelope format as user-profiles.js and user-tokens.js:
 *   { v: 1, iv: "<hex>", tag: "<hex>", ct: "<hex>" }
 *
 * Each file type gets a unique derived key via HKDF-SHA256 domain separation.
 *
 * Auto-migration: if a file contains plaintext JSON on read, it's returned
 * as-is (the next writeEncryptedJson call will encrypt it).
 *
 * Graceful fallback: if TOKEN_ENCRYPTION_KEY is not set, reads/writes
 * plaintext with a console warning.
 */

const fs = require('fs');
const crypto = require('crypto');
const { atomicWriteJsonSync } = require('./atomic-write');

const RAW_KEY = process.env.TOKEN_ENCRYPTION_KEY || '';

/** Derive a 32-byte key with HKDF-SHA256, domain-separated. Returns null when no key is configured. */
function _deriveKey(domain) {
  if (!RAW_KEY) return null;
  return crypto.hkdfSync('sha256', Buffer.from(RAW_KEY, 'utf8'), Buffer.alloc(0), domain, 32);
}

/** Encrypt a UTF-8 string with AES-256-GCM. Returns envelope JSON string, or passthrough if no key. */
function _encrypt(plaintext, domain) {
  const key = _deriveKey(domain);
  if (!key) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: tag.toString('hex'), ct: enc.toString('hex') });
}

/** Decrypt an envelope string back to UTF-8. Returns plaintext on non-envelope input (legacy compat). */
function _decrypt(value, domain) {
  if (typeof value !== 'string') return value;
  let env;
  try { env = JSON.parse(value); } catch { return value; }
  if (!env || env.v !== 1 || !env.iv || !env.tag || !env.ct) return value;
  const key = _deriveKey(domain);
  if (!key) {
    console.warn(`[encrypted-json] Encrypted data found but TOKEN_ENCRYPTION_KEY not set — cannot decrypt (domain: ${domain})`);
    return null;
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(env.ct, 'hex')), decipher.final()]).toString('utf8');
  } catch (err) {
    console.warn(`[encrypted-json] Decryption failed (domain: ${domain}): ${err.message}`);
    return null;
  }
}

/**
 * Read a JSON file, decrypting if it contains an encrypted envelope.
 *
 * Auto-migration: if the file contains plaintext JSON, it's parsed and
 * returned directly. The next writeEncryptedJson call will encrypt it.
 *
 * @param {string} filePath - Absolute path to the JSON file
 * @param {string} domain   - HKDF domain string for key derivation (e.g. 'mybot-signal-uuid-phone')
 * @returns {*} Parsed JSON data (object, array, etc.), or empty object if file missing/unreadable
 */
function readEncryptedJson(filePath, domain) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return {};

    // Try parsing as plain JSON first — handles both plaintext files
    // AND the encrypted envelope (which is also valid JSON).
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return {}; }

    // Check if the parsed object IS an encrypted envelope
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && parsed.v === 1 && parsed.iv && parsed.tag && parsed.ct) {
      // Entire file is a single encrypted envelope
      const plaintext = _decrypt(raw, domain);
      if (plaintext == null) return {};
      try { return JSON.parse(plaintext); } catch { return {}; }
    }

    // Not an envelope — return as-is (plaintext auto-migration path)
    if (!RAW_KEY) {
      // Only warn once per domain per process to avoid log spam
      if (!readEncryptedJson._warned) readEncryptedJson._warned = new Set();
      if (!readEncryptedJson._warned.has(domain)) {
        readEncryptedJson._warned.add(domain);
        console.warn(`[encrypted-json] TOKEN_ENCRYPTION_KEY not set — reading ${filePath} as plaintext`);
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Write JSON data to a file, encrypting the entire contents.
 *
 * @param {string} filePath - Absolute path to the JSON file
 * @param {*}      data     - Data to serialize (object, array, etc.)
 * @param {string} domain   - HKDF domain string for key derivation
 */
function writeEncryptedJson(filePath, data, domain) {
  const plaintext = JSON.stringify(data, null, 2);
  const encrypted = _encrypt(plaintext, domain);
  // If encryption produced an envelope string, write it raw (it's already JSON).
  // If no key was configured, _encrypt returned the plaintext string as-is —
  // write it through atomicWriteJsonSync for consistent formatting.
  if (encrypted !== plaintext) {
    // encrypted is a JSON string of the envelope — write it as a raw file
    // (not double-serialized). Use atomicWriteJsonSync with the parsed envelope.
    const envelope = JSON.parse(encrypted);
    atomicWriteJsonSync(filePath, envelope);
  } else {
    // No encryption — write plaintext JSON
    if (!RAW_KEY) {
      if (!writeEncryptedJson._warned) writeEncryptedJson._warned = new Set();
      if (!writeEncryptedJson._warned.has(domain)) {
        writeEncryptedJson._warned.add(domain);
        console.warn(`[encrypted-json] TOKEN_ENCRYPTION_KEY not set — writing ${filePath} as plaintext`);
      }
    }
    atomicWriteJsonSync(filePath, data);
  }
}

module.exports = { readEncryptedJson, writeEncryptedJson };
