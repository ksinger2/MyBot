/**
 * User profile storage for Signal group members.
 *
 * Profiles are keyed by phone number and persist across sessions.
 * Stored in /app/data/user-profiles.json
 *
 * Each profile:
 *   {
 *     name: "Mike",
 *     location: "Austin, TX",
 *     timezone: "America/Chicago",
 *     gcal_email: "mike@gmail.com",   // set after Google OAuth
 *     gcal_connected: true,           // whether Google Calendar is linked
 *     setup_complete: true,
 *     preferences: [
 *       { fact: 'vegetarian', source: 'conversation', learnedAt: '2026-04-11T22:00:00Z' },
 *     ],
 *     updatedAt: "2026-04-11T..."
 *   }
 *
 * Google OAuth tokens are stored separately in user-tokens.js (same key = phone number).
 *
 * Profiles are encrypted at rest with AES-256-GCM using TOKEN_ENCRYPTION_KEY.
 * Legacy plain-object entries are still readable (auto-migration on next write).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJsonSync } = require('./atomic-write');

const PROFILES_FILE = '/app/data/user-profiles.json';

// ── Encryption helpers (same pattern as user-tokens.js, domain-separated) ──

const RAW_KEY = process.env.TOKEN_ENCRYPTION_KEY || '';

/** Derive a 32-byte key with HKDF-SHA256. Returns null when no key is configured. */
function _key() {
  if (!RAW_KEY) return null;
  return crypto.hkdfSync('sha256', Buffer.from(RAW_KEY, 'utf8'), Buffer.alloc(0), 'mybot-user-profiles', 32);
}

/** Encrypt a UTF-8 string with AES-256-GCM. Returns an envelope JSON string or passthrough. */
function _encrypt(plaintext) {
  const key = _key();
  if (!key) return plaintext; // pass-through if no key configured
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: tag.toString('hex'), ct: enc.toString('hex') });
}

/** Decrypt an envelope string back to UTF-8. Passes through non-envelope values (legacy compat). */
function _decrypt(value) {
  if (typeof value !== 'string') return value;
  let env;
  try { env = JSON.parse(value); } catch { return value; }
  if (!env || env.v !== 1 || !env.iv || !env.tag || !env.ct) return value;
  const key = _key();
  if (!key) {
    console.warn('[user-profiles] encrypted profile in store but TOKEN_ENCRYPTION_KEY not set — cannot decrypt');
    return null;
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(env.ct, 'hex')), decipher.final()]).toString('utf8');
  } catch (err) {
    console.warn(`[user-profiles] failed to decrypt: ${err.message}`);
    return null;
  }
}

/**
 * Decode a stored entry back into a profile object.
 * Handles legacy plain objects AND encrypted-envelope strings.
 */
function _decodeEntry(entry) {
  if (!entry) return null;
  // Legacy: already a plain object on disk — return as-is.
  if (typeof entry === 'object') return entry;
  // Encrypted (or pass-through) string — decrypt then parse.
  const plain = _decrypt(entry);
  if (plain == null) return null;
  if (typeof plain !== 'string') return plain;
  try { return JSON.parse(plain); } catch { return null; }
}

// ── Low-level store I/O ──

function readStore() {
  try {
    if (!fs.existsSync(PROFILES_FILE)) return {};
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  } catch { return {}; }
}

function writeStore(store) {
  atomicWriteJsonSync(PROFILES_FILE, store);
}

// ── Core CRUD ──

/** Get a user's profile by phone number. Returns null if not found. */
function getProfile(phoneNumber) {
  const store = readStore();
  if (!(phoneNumber in store)) return null;
  return _decodeEntry(store[phoneNumber]);
}

/** Create or update fields in a user's profile. Encrypts before storing. */
function setProfile(phoneNumber, fields) {
  const store = readStore();
  const existing = _decodeEntry(store[phoneNumber]) || {};
  const merged = {
    ...existing,
    ...fields,
    updatedAt: new Date().toISOString(),
  };
  store[phoneNumber] = _encrypt(JSON.stringify(merged));
  writeStore(store);
  return merged;
}

/** Mark a user's Google Calendar as connected (called after successful OAuth). */
function markCalendarConnected(phoneNumber, gcalEmail) {
  return setProfile(phoneNumber, { gcal_email: gcalEmail, gcal_connected: true });
}

/** Get all profiles (owner use only). Decrypts each entry. */
function getAllProfiles() {
  const store = readStore();
  const result = {};
  for (const [phone, entry] of Object.entries(store)) {
    const profile = _decodeEntry(entry);
    if (profile) result[phone] = profile;
  }
  return result;
}

/** Delete a profile (legacy alias — prefer deleteUser). */
function deleteProfile(phoneNumber) {
  const store = readStore();
  delete store[phoneNumber];
  writeStore(store);
}

// ── Preferences helpers ──

/** Append a learned preference. Caps at 50 per user.
 *  Auto-creates a minimal profile if one doesn't exist yet (e.g. first
 *  interaction in a group chat before the onboarding wizard runs). */
function addPreference(phone, fact, source = 'conversation') {
  let profile = getProfile(phone);
  if (!profile) {
    // Bootstrap a stub profile so preferences have somewhere to live.
    setProfile(phone, {});
    profile = getProfile(phone) || {};
  }
  if (!profile.preferences) profile.preferences = [];
  // Cap at 50 preferences per user
  if (profile.preferences.length >= 50) profile.preferences.shift();
  profile.preferences.push({
    fact: fact.substring(0, 200), // limit length
    source, // 'conversation' or 'explicit'
    learnedAt: new Date().toISOString(),
  });
  setProfile(phone, profile);
  return true;
}

/** Remove preferences whose fact contains the keyword (case-insensitive). Returns count removed. */
function removePreference(phone, keyword) {
  const profile = getProfile(phone);
  if (!profile || !profile.preferences) return 0;
  const before = profile.preferences.length;
  profile.preferences = profile.preferences.filter(
    p => !p.fact.toLowerCase().includes(keyword.toLowerCase())
  );
  const removed = before - profile.preferences.length;
  if (removed > 0) setProfile(phone, profile);
  return removed;
}

/** Clear all preferences but keep the rest of the profile. */
function clearPreferences(phone) {
  const profile = getProfile(phone);
  if (!profile) return false;
  profile.preferences = [];
  setProfile(phone, profile);
  return true;
}

/** Completely remove a user's profile and all associated data (tokens, schedules). */
function deleteUser(phone) {
  const store = readStore();
  if (!(phone in store)) return false;
  delete store[phone];
  writeStore(store);
  // Clean up OAuth tokens
  try { require('./user-tokens').removeToken(phone); } catch {}
  // Clean up scheduled jobs and cancel active cron jobs
  try {
    const { removeAllUserSchedules } = require('./schedules-storage');
    removeAllUserSchedules(phone);
    const { cancelUserJobs } = require('./scheduler');
    cancelUserJobs(phone);
  } catch {}
  return true;
}

/**
 * Return a user-safe view of the profile (excludes internal flags like 'greeted').
 * Returns null if user has no profile.
 */
function getUserData(phone) {
  const profile = getProfile(phone);
  if (!profile) return null;
  return {
    name: profile.name,
    location: profile.location,
    timezone: profile.timezone,
    gcal_connected: !!profile.gcal_connected,
    gcal_email: profile.gcal_email || null,
    preferences: (profile.preferences || []).map(p => ({
      fact: p.fact,
      source: p.source,
      learnedAt: p.learnedAt,
    })),
    tags: (profile.tags || []).map(t => ({
      label: t.label,
      category: t.category,
      addedAt: t.addedAt,
    })),
    setup_complete: !!profile.setup_complete,
  };
}

// ── Tags helpers ──

/** Add a tag (user-curated identity label). Caps at 30 per user, deduplicates by label. */
function addTag(phone, label, category = 'Custom') {
  let profile = getProfile(phone);
  if (!profile) {
    setProfile(phone, {});
    profile = getProfile(phone) || {};
  }
  if (!profile.tags) profile.tags = [];
  const normalizedLabel = label.trim().substring(0, 100);
  if (!normalizedLabel) return null;
  // Dedup by label (case-insensitive)
  if (profile.tags.some(t => t.label.toLowerCase() === normalizedLabel.toLowerCase())) return null;
  if (profile.tags.length >= 30) return null;
  const tag = { label: normalizedLabel, category: category.trim().substring(0, 50), addedAt: new Date().toISOString() };
  profile.tags.push(tag);
  setProfile(phone, profile);
  return tag;
}

/** Remove a tag by exact label match. Returns count removed. */
function removeTag(phone, label) {
  const profile = getProfile(phone);
  if (!profile || !profile.tags) return 0;
  const before = profile.tags.length;
  profile.tags = profile.tags.filter(t => t.label !== label);
  const removed = before - profile.tags.length;
  if (removed > 0) setProfile(phone, profile);
  return removed;
}

// ── System-prompt builder ──

/**
 * Build a system-prompt snippet describing this user to Claude.
 * Injected into every Signal request so Claude knows who it's talking to.
 */
function buildProfileContext(phoneNumber) {
  const profile = getProfile(phoneNumber);
  if (!profile) return null;

  const lines = [`USER PROFILE (this message is from ${phoneNumber}):`];
  if (profile.name)     lines.push(`- Name: ${profile.name}`);
  if (profile.location) lines.push(`- Location: ${profile.location}`);
  if (profile.timezone) lines.push(`- Timezone: ${profile.timezone}`);
  if (profile.gcal_email && profile.gcal_connected) {
    lines.push(`- Google Calendar: ${profile.gcal_email} (read-only access granted)`);
    lines.push(`When this user asks about calendar events, use their Google Calendar (${profile.gcal_email}).`);
  } else {
    lines.push(`- Google Calendar: not connected`);
  }
  if (profile.spotify_connected) {
    const artists = (profile.tags || []).filter(t => t.category === 'Artist').map(t => t.label);
    if (artists.length > 0) {
      lines.push(`- Spotify: connected — favorite artists: ${artists.join(', ')}`);
      lines.push(`When this user asks about concerts, events, or tickets, prioritize their favorite artists. Proactively mention upcoming shows in their area.`);
    } else {
      lines.push(`- Spotify: connected (no artist data yet)`);
    }
  }
  if (profile.tags && profile.tags.length > 0) {
    const tagStr = profile.tags.map(t => t.category !== 'Custom' ? `${t.label} (${t.category})` : t.label).join(', ');
    lines.push(`- Tags: ${tagStr}`);
  }
  if (profile.preferences && profile.preferences.length > 0) {
    const facts = profile.preferences.map(p => p.fact).join(', ');
    lines.push(`- Preferences: ${facts}`);
  }
  if (profile.location) {
    lines.push(`When this user asks about weather or local info, always use their location: ${profile.location}.`);
  }

  return lines.join('\n');
}

module.exports = {
  getProfile,
  setProfile,
  markCalendarConnected,
  getAllProfiles,
  deleteProfile,
  buildProfileContext,
  addPreference,
  removePreference,
  clearPreferences,
  addTag,
  removeTag,
  deleteUser,
  getUserData,
};
