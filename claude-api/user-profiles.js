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
 *     updatedAt: "2026-04-11T..."
 *   }
 *
 * Google OAuth tokens are stored separately in user-tokens.js (same key = phone number).
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

const PROFILES_FILE = '/app/data/user-profiles.json';

function _read() {
  try {
    if (!fs.existsSync(PROFILES_FILE)) return {};
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  } catch { return {}; }
}

function _write(store) {
  atomicWriteJsonSync(PROFILES_FILE, store);
}

/** Get a user's profile by phone number. Returns null if not found. */
function getProfile(phoneNumber) {
  return _read()[phoneNumber] || null;
}

/** Create or update fields in a user's profile. */
function setProfile(phoneNumber, fields) {
  const store = _read();
  store[phoneNumber] = {
    ...(store[phoneNumber] || {}),
    ...fields,
    updatedAt: new Date().toISOString(),
  };
  _write(store);
  return store[phoneNumber];
}

/** Mark a user's Google Calendar as connected (called after successful OAuth). */
function markCalendarConnected(phoneNumber, gcalEmail) {
  return setProfile(phoneNumber, { gcal_email: gcalEmail, gcal_connected: true });
}

/** Get all profiles (owner use only). */
function getAllProfiles() {
  return _read();
}

/** Delete a profile. */
function deleteProfile(phoneNumber) {
  const store = _read();
  delete store[phoneNumber];
  _write(store);
}

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
};
