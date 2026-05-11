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
  let profile = (phoneNumber in store) ? _decodeEntry(store[phoneNumber]) : null;
  // UUID→phone resolution: if identifier is a UUID with no direct entry, find
  // the phone-keyed profile that references this UUID via signalUuid.
  if (!profile && phoneNumber && !phoneNumber.startsWith('+') && phoneNumber.includes('-')) {
    for (const [key, entry] of Object.entries(store)) {
      const p = _decodeEntry(entry);
      if (p && p.signalUuid === phoneNumber) { profile = p; break; }
    }
  }
  // Phone→UUID merge: if phone profile has a signalUuid AND there's a separate
  // UUID-keyed profile with fields missing from phone (e.g. gcal_connected
  // stored under UUID during OAuth), merge them so lookups always find the data.
  if (profile && profile.signalUuid && store[profile.signalUuid]) {
    const uuidProfile = _decodeEntry(store[profile.signalUuid]);
    if (uuidProfile) {
      for (const [k, v] of Object.entries(uuidProfile)) {
        if (v != null && v !== false && (profile[k] === undefined || profile[k] === null || profile[k] === false)) {
          profile[k] = v;
        }
      }
    }
  }
  return profile;
}

/** Create or update fields in a user's profile. Encrypts before storing. */
function setProfile(phoneNumber, fields) {
  const store = readStore();
  const existing = _decodeEntry(store[phoneNumber]) || {};
  // Protect notes from accidental wipe — never overwrite existing notes with empty
  if (Array.isArray(existing.notes) && existing.notes.length > 0) {
    if (Array.isArray(fields.notes) && fields.notes.length === 0) {
      delete fields.notes; // don't overwrite non-empty notes with empty array
    }
  }
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

/** Add a rule (explicit behavioral instruction). Caps at 20, no duplicates. */
function addRule(phone, rule) {
  let profile = getProfile(phone);
  if (!profile) {
    setProfile(phone, {});
    profile = getProfile(phone) || {};
  }
  if (!profile.rules) profile.rules = [];
  if (profile.rules.length >= 20) profile.rules.shift();
  const text = rule.substring(0, 200).trim();
  if (!text) return false;
  profile.rules.push({ rule: text, addedAt: new Date().toISOString() });
  setProfile(phone, profile);
  return true;
}

/** Remove rules whose text contains the keyword (case-insensitive). Returns count removed. */
function removeRule(phone, keyword) {
  const profile = getProfile(phone);
  if (!profile || !profile.rules) return 0;
  const before = profile.rules.length;
  profile.rules = profile.rules.filter(r => !r.rule.toLowerCase().includes(keyword.toLowerCase()));
  const removed = before - profile.rules.length;
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
  if (profile.tags.length >= 500) return null;
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
function buildGroupMemberContext(phoneNumber) {
  const profile = getProfile(phoneNumber);
  if (!profile) return null;
  const _s = (str, maxLen = 200) => {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/[\[\]{}<>]/g, '').substring(0, maxLen).trim();
  };
  const lines = [`OTHER GROUP MEMBER (${phoneNumber}):`];
  if (profile.name)     lines.push(`- Name: ${_s(profile.name, 50)}`);
  if (profile.pronouns) lines.push(`- Pronouns: ${_s(profile.pronouns, 20)} — ALWAYS use these pronouns for this person.`);
  if (profile.gcal_email && profile.gcal_connected) {
    lines.push(`- Google Calendar: connected`);
  }
  if (profile.eightsleep_connected) {
    lines.push(`- Eight Sleep: connected`);
  }
  return lines.join('\n');
}

function buildProfileContext(phoneNumber, { isGroupChat = false } = {}) {
  const profile = getProfile(phoneNumber);
  if (!profile) return null;

  // Sanitize user-controlled strings to prevent prompt injection.
  // Strips characters commonly used in injection attempts: [ ] { } < >
  // and limits length to prevent context stuffing.
  const _s = (str, maxLen = 200) => {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/[\[\]{}<>]/g, '').substring(0, maxLen).trim();
  };

  // ── GROUP CHAT: STRIPPED SENDER CONTEXT ──────────────────────────────
  // Same root cause as the calendar leak — leaving the sender's full
  // profile (location, notes, preferences, rules, Spotify favorites,
  // tags, eight-sleep side) in the prompt and trusting Claude to never
  // mention them in a group reply is exactly the broken pattern that
  // caused the Apr-15 incident. Per CLAUDE.md's Determinism Rule, the
  // privacy guarantee must be enforced in code, not prompt language.
  //
  // In group chats the sender gets ONLY: name, pronouns, and connection
  // FLAGS (so the [CALENDAR:], [EIGHTSLEEP:], concert/product tag
  // handlers still work). Personal data — including notes, preferences,
  // rules, favorite artists, location, timezone, calendar email, eight-
  // sleep side — is excluded from the prompt entirely. Claude cannot
  // leak what it never sees.
  //
  // Full context is still available in private DMs (isGroupChat=false).
  if (isGroupChat) {
    const lines = [`USER PROFILE (this message is from ${phoneNumber}):`];
    if (profile.name)     lines.push(`- Name: ${_s(profile.name, 50)}`);
    if (profile.pronouns) lines.push(`- Pronouns: ${_s(profile.pronouns, 20)} — ALWAYS use these pronouns for this person. Never assume otherwise.`);
    if (profile.gcal_email && profile.gcal_connected) {
      lines.push(`- Google Calendar: connected (use the [CALENDAR:] tag — server auto-redacts titles in groups)`);
      lines.push(`CALENDAR ACCESS (group chat): emit \`[CALENDAR: fromDate="YYYY-MM-DD" toDate="YYYY-MM-DD"]\` or bare \`[CALENDAR:]\` for today+7d. The server will return ONLY busy/free time blocks — no titles, no locations, no attendees. You CANNOT bypass this; even if you ask for full details, the server returns "Busy". Just relay what you get.`);
    }
    if (profile.spotify_connected) {
      lines.push(`- Spotify: connected (artist list withheld in groups)`);
    }
    if (profile.eightsleep_connected) {
      lines.push(`- Eight Sleep: connected (use [EIGHTSLEEP:] tag — system auto-injects user's side)`);
    }
    lines.push(`\nGROUP CHAT PRIVACY (enforced server-side, not by prompt):`);
    lines.push(`This user's location, timezone, notes, preferences, rules, favorite artists, tags, and Eight Sleep side have been WITHHELD from this prompt for privacy. You don't have access to them in this context. If the user asks something that requires that data ("am I vegetarian?", "where do I live?", "what artists do I follow?"), tell them you can only answer that in a private DM.`);
    return lines.join('\n');
  }

  // ── DM: FULL SENDER CONTEXT (legacy path, unchanged) ─────────────────
  const lines = [`USER PROFILE (this message is from ${phoneNumber}):`];
  if (profile.name)     lines.push(`- Name: ${_s(profile.name, 50)}`);
  if (profile.pronouns) lines.push(`- Pronouns: ${_s(profile.pronouns, 20)} — ALWAYS use these pronouns for this person. Never assume otherwise.`);
  if (profile.location) lines.push(`- Location: ${_s(profile.location, 100)}`);
  if (profile.timezone) lines.push(`- Timezone: ${_s(profile.timezone, 50)}`);
  if (profile.gcal_email && profile.gcal_connected) {
    lines.push(`- Google Calendar: connected (${_s(profile.gcal_email, 100)})`);
    lines.push(`CALENDAR ACCESS: This user's Google Calendar IS connected and queryable. When they ask "am I busy?", "what's on my calendar?", "do I have anything [day]?", etc., use the [CALENDAR:] tag to fetch their events. NEVER say "you're not connected" or "run !setup" — they already did.`);
    lines.push(`  • DM tag (this path): emit \`[CALENDAR: fromDate="YYYY-MM-DD" toDate="YYYY-MM-DD"]\` or bare \`[CALENDAR:]\` for today+7d. The system auto-injects the user's id and returns full event details (this is a DM, not a group).`);
    lines.push(`  • There is NO curl alternative — the [CALENDAR:] tag is the only way to read the user's calendar. The system handles auth and user-id injection deterministically server-side.`);
    // Note: the legacy "group privacy" prompt instruction that used to
    // live here has been deleted. Group privacy is now enforced at the
    // server level (server.js /calendar/events redacts to "Busy" when
    // isGroupChat is anything other than the strict boolean false) AND
    // by short-circuiting this whole function when isGroupChat=true
    // above. Prompts as a security mechanism are an antipattern.
  } else {
    lines.push(`- Google Calendar: not connected`);
  }
  if (profile.spotify_connected) {
    const artists = (profile.tags || []).filter(t => t.category === 'Artist').map(t => _s(t.label, 100));
    if (artists.length > 0) {
      const displayArtists = artists.slice(0, 30);
      const suffix = artists.length > 30 ? ` (and ${artists.length - 30} more)` : '';
      lines.push(`- Spotify: connected — top artists: ${displayArtists.join(', ')}${suffix}`);
      lines.push(`Prioritize these artists for concert/ticket queries.`);
    } else {
      lines.push(`- Spotify: connected (no artist data yet)`);
    }
  }
  // Only show non-Artist tags (hobbies, custom) — Artist tags already in Spotify line
  if (profile.tags && profile.tags.length > 0) {
    const nonArtistTags = profile.tags.filter(t => t.category !== 'Artist');
    if (nonArtistTags.length > 0) {
      const tagStr = nonArtistTags.map(t => t.category !== 'Custom' ? `${_s(t.label)} (${_s(t.category, 50)})` : _s(t.label)).join(', ');
      lines.push(`- Tags: ${tagStr}`);
    }
  }
  if (profile.preferences && profile.preferences.length > 0) {
    const facts = profile.preferences.map(p => _s(p.fact)).join(', ');
    lines.push(`- Preferences: ${facts}`);
  }
  if (profile.location) {
    lines.push(`When this user asks about weather or local info, always use their location: ${_s(profile.location, 100)}.`);
  }
  if (profile.rules && profile.rules.length > 0) {
    lines.push(`\nSTRICT USER RULES — follow these exactly, they override defaults:`);
    for (const r of profile.rules) lines.push(`- ${_s(r.rule)}`);
  }
  if (profile.eightsleep_connected) {
    const side = profile.eightsleep_side || 'unknown';
    lines.push(`- Eight Sleep: connected — this user sleeps on the **${side}** side. When they say "my bed" or "my side", use [EIGHTSLEEP: action ${side}]. Do NOT ask which side — you already know.`);
  }
  // Inject personal notes (supports both legacy string and new array format)
  const notesArr = Array.isArray(profile.notes) ? profile.notes
    : (profile.notes && profile.notes.trim() ? [{ id: 'legacy', title: 'Notes', content: profile.notes }] : []);
  if (notesArr.length > 0) {
    lines.push(`\n[USER NOTES — personal reference data for this user:]`);
    let totalChars = 0;
    for (const n of notesArr) {
      if (totalChars > 5000) { lines.push('(additional notes truncated)'); break; }
      const title = _s(n.title, 100) || 'Untitled';
      const content = (n.content || '').substring(0, 2000);
      lines.push(`\n### ${title} (note id: ${n.id})\n${content}`);
      totalChars += content.length;
    }
  }

  return lines.join('\n');
}

// ── Minimal (compact) profile context — always injected ──

/**
 * Build a compact profile context for the system prompt (~500-1200 chars).
 * Includes: identity, location, rules, capability flags, and a "menu"
 * of available data so Claude knows what it can reference.
 * Heavy data (artists, notes) is NOT included — use buildProfileLookup().
 */
function buildMinimalProfileContext(phoneNumber, { isGroupChat = false } = {}) {
  // Group chats use the existing stripped path
  if (isGroupChat) return buildProfileContext(phoneNumber, { isGroupChat: true });

  const profile = getProfile(phoneNumber);
  if (!profile) return null;

  const _s = (str, maxLen = 200) => {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/[\[\]{}<>]/g, '').substring(0, maxLen).trim();
  };

  const lines = [`USER PROFILE (this message is from ${phoneNumber}):`];
  if (profile.name) lines.push(`- Name: ${_s(profile.name, 50)}`);
  if (profile.pronouns) lines.push(`- Pronouns: ${_s(profile.pronouns, 20)} — ALWAYS use these pronouns for this person. Never assume otherwise.`);
  if (profile.location) lines.push(`- Location: ${_s(profile.location, 100)}`);
  if (profile.timezone) lines.push(`- Timezone: ${_s(profile.timezone, 50)}`);

  // Capability flags — short, tells Claude the feature exists
  if (profile.gcal_email && profile.gcal_connected) {
    lines.push(`- Google Calendar: connected (${_s(profile.gcal_email, 100)})`);
    lines.push(`CALENDAR ACCESS: This user's Google Calendar IS connected and queryable. When they ask "am I busy?", "what's on my calendar?", "do I have anything [day]?", etc., use the [CALENDAR:] tag to fetch their events. NEVER say "you're not connected" or "run !setup" — they already did.`);
    lines.push(`  • DM tag (this path): emit \`[CALENDAR: fromDate="YYYY-MM-DD" toDate="YYYY-MM-DD"]\` or bare \`[CALENDAR:]\` for today+7d. The system auto-injects the user's id and returns full event details (this is a DM, not a group).`);
    lines.push(`  • There is NO curl alternative — the [CALENDAR:] tag is the only way to read the user's calendar. The system handles auth and user-id injection deterministically server-side.`);
  }
  if (profile.spotify_connected) {
    const artistCount = (profile.tags || []).filter(t => t.category === 'Artist').length;
    lines.push(`- Spotify: connected (${artistCount} artists on file — injected automatically for concert/music queries)`);
  }
  if (profile.eightsleep_connected) {
    const side = profile.eightsleep_side || 'unknown';
    lines.push(`- Eight Sleep: connected — this user sleeps on the **${side}** side. When they say "my bed" or "my side", use [EIGHTSLEEP: action ${side}]. Do NOT ask which side — you already know.`);
  }

  // Non-Artist tags (hobbies, custom) — small, always include
  if (profile.tags && profile.tags.length > 0) {
    const nonArtistTags = profile.tags.filter(t => t.category !== 'Artist');
    if (nonArtistTags.length > 0) {
      const tagStr = nonArtistTags.map(t => t.category !== 'Custom' ? `${_s(t.label)} (${_s(t.category, 50)})` : _s(t.label)).join(', ');
      lines.push(`- Tags: ${tagStr}`);
    }
  }

  // Preferences — usually short, always include
  if (profile.preferences && profile.preferences.length > 0) {
    const facts = profile.preferences.map(p => _s(p.fact)).join(', ');
    lines.push(`- Preferences: ${facts}`);
  }

  if (profile.location) {
    lines.push(`When this user asks about weather or local info, always use their location: ${_s(profile.location, 100)}.`);
  }

  // Rules — ALWAYS injected. They're behavioral constraints that must be
  // respected from the first message. Cannot be deferred to on-demand lookup.
  if (profile.rules && profile.rules.length > 0) {
    lines.push(`\nSTRICT USER RULES — follow these exactly, they override defaults:`);
    for (const r of profile.rules) lines.push(`- ${_s(r.rule)}`);
  }

  // Notes menu — just titles and counts so Claude knows what's available
  const notesArr = Array.isArray(profile.notes) ? profile.notes
    : (profile.notes && profile.notes.trim() ? [{ id: 'legacy', title: 'Notes', content: profile.notes }] : []);
  if (notesArr.length > 0) {
    const titles = notesArr.map(n => `"${_s(n.title, 100) || 'Untitled'}" (id: ${n.id})`).join(', ');
    lines.push(`- Notes on file: ${titles} — full content injected automatically when relevant to the message`);
  }

  return lines.join('\n');
}

/**
 * Build on-demand profile data for specific fields.
 * Called by bot.js when message heuristics indicate the data is needed.
 *
 * @param {string} phoneNumber
 * @param {string[]} fields - Array of: 'artists', 'notes', 'note:<id>'
 * @returns {string|null}
 */
function buildProfileLookup(phoneNumber, fields) {
  const profile = getProfile(phoneNumber);
  if (!profile || !fields || fields.length === 0) return null;

  const _s = (str, maxLen = 200) => {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/[\[\]{}<>]/g, '').substring(0, maxLen).trim();
  };

  const parts = [];

  for (const field of fields) {
    if (field === 'artists') {
      const artists = (profile.tags || []).filter(t => t.category === 'Artist').map(t => _s(t.label, 100));
      if (artists.length > 0) {
        const displayArtists = artists.slice(0, 30);
        const suffix = artists.length > 30 ? ` (and ${artists.length - 30} more)` : '';
        parts.push(`[USER SPOTIFY ARTISTS — top ${displayArtists.length}${suffix}:]\n${displayArtists.join(', ')}\nPrioritize these artists for concert/ticket queries.`);
      }
    } else if (field === 'notes') {
      const notesArr = Array.isArray(profile.notes) ? profile.notes
        : (profile.notes && profile.notes.trim() ? [{ id: 'legacy', title: 'Notes', content: profile.notes }] : []);
      if (notesArr.length > 0) {
        const noteLines = ['[USER NOTES — personal reference data for this user:]'];
        let totalChars = 0;
        for (const n of notesArr) {
          if (totalChars > 5000) { noteLines.push('(additional notes truncated)'); break; }
          const title = _s(n.title, 100) || 'Untitled';
          const content = _s(n.content, 2000);
          noteLines.push(`\n### ${title} (note id: ${n.id})\n${content}`);
          totalChars += content.length;
        }
        parts.push(noteLines.join('\n'));
      }
    } else if (field.startsWith('note:')) {
      const noteId = field.slice(5);
      const notesArr = Array.isArray(profile.notes) ? profile.notes : [];
      const note = notesArr.find(n => n.id === noteId);
      if (note) {
        const title = _s(note.title, 100) || 'Untitled';
        const content = _s(note.content, 3000);
        parts.push(`[USER NOTE — ${title}:]\n${content}`);
      }
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ── Signal UUID helpers ──

/**
 * Store a Signal UUID against a user's profile so the group context builder
 * can resolve UUID→phone even when the adapter's in-memory/disk cache misses.
 * Called whenever a message arrives from a known phone number with a UUID.
 * No-ops gracefully if the profile doesn't exist yet.
 */
function saveSignalUuid(phoneNumber, uuid) {
  if (!phoneNumber || !uuid) return;
  const existing = getProfile(phoneNumber);
  // Only write if the uuid is new or different — avoids unnecessary disk I/O
  if (existing && existing.signalUuid === uuid) return;
  setProfile(phoneNumber, { signalUuid: uuid });
}

/**
 * Scan all profiles for one whose `signalUuid` matches the given UUID.
 * Returns the phone number (profile key) or null if not found.
 * Used as a last-resort fallback when the adapter cache has no UUID→phone entry.
 */
function findProfileBySignalUuid(uuid) {
  if (!uuid) return null;
  const store = readStore();
  for (const [key, entry] of Object.entries(store)) {
    // Profile explicitly stored their UUID
    const profile = _decodeEntry(entry);
    if (profile && profile.signalUuid === uuid) return key;
    // Profile is keyed by UUID directly (when Signal never sent a phone number)
    if (key === uuid) return key;
  }
  return null;
}

module.exports = {
  getProfile,
  setProfile,
  markCalendarConnected,
  getAllProfiles,
  deleteProfile,
  buildProfileContext,
  buildMinimalProfileContext,
  buildProfileLookup,
  buildGroupMemberContext,
  addPreference,
  removePreference,
  clearPreferences,
  addRule,
  removeRule,
  addTag,
  removeTag,
  deleteUser,
  getUserData,
  saveSignalUuid,
  findProfileBySignalUuid,
};
