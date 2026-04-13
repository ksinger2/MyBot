/**
 * Group Notes — tracks action items, shared content, and questions in group chats.
 *
 * Claude detects noteworthy items (questions asked, videos/links shared, tasks
 * assigned) and tags them with [NOTE:...] in its response. This module stores
 * them and periodically sends DM reminders to the targeted users.
 *
 * Note schema:
 *   {
 *     id: "abc123",
 *     groupId: "group-chat-id",
 *     type: "question" | "content" | "task",
 *     summary: "Check the TikTok video Mike shared",
 *     from: "+15551234567",        // who created the note (sender)
 *     fromName: "Mike",
 *     target: "+15559876543",      // who should be reminded (null = everyone)
 *     targetName: "Karen",
 *     resolved: false,
 *     createdAt: 1712966400000,
 *     remindedAt: null,            // last reminder sent
 *     remindCount: 0,
 *   }
 *
 * Storage: /app/data/group-notes.json (encrypted at rest)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJsonSync, atomicWriteFileSync } = require('./atomic-write');

const NOTES_FILE = '/app/data/group-notes.json';
const MAX_NOTE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000;  // remind at most every 4 hours
const MAX_REMINDERS = 3; // stop reminding after 3 attempts

// ── Encryption (same pattern as session-journal.js) ──

const RAW_KEY = process.env.TOKEN_ENCRYPTION_KEY || '';

function _key() {
  if (!RAW_KEY) return null;
  return crypto.hkdfSync('sha256', Buffer.from(RAW_KEY, 'utf8'), Buffer.alloc(0), 'mybot-group-notes', 32);
}

function _encrypt(plaintext) {
  const key = _key();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: tag.toString('hex'), ct: enc.toString('hex') });
}

function _decrypt(value) {
  if (typeof value !== 'string') return value;
  let env;
  try { env = JSON.parse(value); } catch { return value; }
  if (!env || env.v !== 1) return value;
  const key = _key();
  if (!key) return value;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
  return decipher.update(Buffer.from(env.ct, 'hex')) + decipher.final('utf8');
}

// ── Storage ──

function _load() {
  try {
    if (!fs.existsSync(NOTES_FILE)) return [];
    const raw = fs.readFileSync(NOTES_FILE, 'utf8');
    const decrypted = _decrypt(raw);
    const parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`[group-notes] failed to load: ${e.message}`);
    return [];
  }
}

function _save(notes) {
  const json = JSON.stringify(notes, null, 2);
  if (_key()) {
    // Encrypted: write as raw string (already JSON-encoded ciphertext)
    atomicWriteFileSync(NOTES_FILE, _encrypt(json));
  } else {
    // Plaintext: write as JSON object
    atomicWriteJsonSync(NOTES_FILE, notes);
  }
}

function _genId() {
  return crypto.randomBytes(6).toString('hex');
}

// ── CRUD ──

function addNote({ groupId, type, summary, from, fromName, target, targetName }) {
  const notes = _load();
  const note = {
    id: _genId(),
    groupId,
    type: type || 'task',
    summary,
    from: from || null,
    fromName: fromName || null,
    target: target || null,
    targetName: targetName || null,
    resolved: false,
    createdAt: Date.now(),
    remindedAt: null,
    remindCount: 0,
  };
  notes.push(note);
  _save(notes);
  console.log(`[group-notes] added note ${note.id}: "${summary}" (${type}) in group ${groupId}`);
  return note;
}

function resolveNote(noteId) {
  const notes = _load();
  const note = notes.find(n => n.id === noteId);
  if (note) {
    note.resolved = true;
    _save(notes);
    console.log(`[group-notes] resolved note ${noteId}`);
  }
  return note;
}

function getGroupNotes(groupId, { includeResolved = false } = {}) {
  const notes = _load();
  return notes.filter(n =>
    n.groupId === groupId &&
    (includeResolved || !n.resolved) &&
    (Date.now() - n.createdAt < MAX_NOTE_AGE_MS)
  );
}

function getUserPendingNotes(userId) {
  const notes = _load();
  return notes.filter(n =>
    !n.resolved &&
    (n.target === userId || n.target === null) &&
    (Date.now() - n.createdAt < MAX_NOTE_AGE_MS)
  );
}

function getNotesForReminder() {
  const notes = _load();
  const now = Date.now();
  return notes.filter(n =>
    !n.resolved &&
    n.target && // only remind targeted notes, not broadcast ones
    n.remindCount < MAX_REMINDERS &&
    (now - n.createdAt < MAX_NOTE_AGE_MS) &&
    (now - n.createdAt > 30 * 60 * 1000) && // wait at least 30 min before first reminder
    (!n.remindedAt || (now - n.remindedAt > REMINDER_INTERVAL_MS))
  );
}

function markReminded(noteId) {
  const notes = _load();
  const note = notes.find(n => n.id === noteId);
  if (note) {
    note.remindedAt = Date.now();
    note.remindCount = (note.remindCount || 0) + 1;
    _save(notes);
  }
}

function pruneExpired() {
  const notes = _load();
  const before = notes.length;
  const kept = notes.filter(n => Date.now() - n.createdAt < MAX_NOTE_AGE_MS);
  if (kept.length < before) {
    _save(kept);
    console.log(`[group-notes] pruned ${before - kept.length} expired note(s)`);
  }
}

// ── Reminder runner ──

let _reminderTimer = null;

function startReminderLoop(sendDm) {
  if (_reminderTimer) return;
  // Check every hour for notes that need reminders
  _reminderTimer = setInterval(async () => {
    try {
      pruneExpired();
      const due = getNotesForReminder();
      if (due.length === 0) return;

      // Group by target user so we send one DM per user
      const byUser = new Map();
      for (const note of due) {
        if (!byUser.has(note.target)) byUser.set(note.target, []);
        byUser.get(note.target).push(note);
      }

      for (const [userId, userNotes] of byUser) {
        const lines = userNotes.map(n => {
          const from = n.fromName || n.from || 'Someone';
          const typeLabel = n.type === 'question' ? 'asked you' : n.type === 'content' ? 'shared something for you to check' : 'wants you to';
          return `• ${from} ${typeLabel}: ${n.summary}`;
        });
        const msg = `Hey! Friendly reminder from your group chat:\n\n${lines.join('\n')}\n\nReply in the group to address these, or they'll clear after a week.`;

        try {
          await sendDm(userId, msg);
          for (const n of userNotes) markReminded(n.id);
          console.log(`[group-notes] sent reminder DM to ${userId.substring(0, 4)}**** (${userNotes.length} note(s))`);
        } catch (e) {
          console.warn(`[group-notes] failed to send reminder to ${userId.substring(0, 4)}****: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`[group-notes] reminder loop error: ${e.message}`);
    }
  }, 60 * 60 * 1000);

  console.log('[group-notes] reminder loop started (checks every 1 hour)');
}

function stopReminderLoop() {
  if (_reminderTimer) {
    clearInterval(_reminderTimer);
    _reminderTimer = null;
  }
}

// ── Note extraction from Claude's response ──

/**
 * Parse [NOTE:...] tags from Claude's response text.
 * Format: [NOTE: type=task|question|content target=+phone targetName=Name summary="the thing"]
 * Simpler format also accepted: [NOTE: @TargetName check the video Mike shared]
 */
function extractNotes(text, { groupId, from, fromName, groupMembers } = {}) {
  const notes = [];
  // Full structured format
  const structuredRe = /\[NOTE:\s*type=(\w+)\s+target=(\S+)\s+targetName=([^\s]+)\s+summary="([^"]+)"\]/gi;
  let match;
  while ((match = structuredRe.exec(text)) !== null) {
    notes.push({
      groupId,
      type: match[1],
      target: match[2],
      targetName: match[3],
      summary: match[4],
      from,
      fromName,
    });
  }

  // Simple format: [NOTE: @TargetName do the thing]
  const simpleRe = /\[NOTE:\s*@(\S+)\s+(.+?)\]/gi;
  while ((match = simpleRe.exec(text)) !== null) {
    // Resolve target name to phone number if possible
    const targetName = match[1];
    let targetId = null;
    if (groupMembers) {
      const member = groupMembers.find(m =>
        m.name && m.name.toLowerCase() === targetName.toLowerCase()
      );
      if (member) targetId = member.id;
    }
    // Skip if already captured by structured format
    const alreadyCaptured = notes.some(n => n.targetName === targetName && n.summary === match[2]);
    if (!alreadyCaptured) {
      notes.push({
        groupId,
        type: 'task',
        target: targetId,
        targetName,
        summary: match[2],
        from,
        fromName,
      });
    }
  }

  return notes;
}

/**
 * Strip [NOTE:...] tags from text so users don't see them.
 */
function stripNoteTags(text) {
  return text
    .replace(/\[NOTE:\s*type=\w+\s+target=\S+\s+targetName=\S+\s+summary="[^"]+"\]/gi, '')
    .replace(/\[NOTE:\s*@\S+\s+.+?\]/gi, '')
    .trim();
}

module.exports = {
  addNote,
  resolveNote,
  getGroupNotes,
  getUserPendingNotes,
  getNotesForReminder,
  extractNotes,
  stripNoteTags,
  startReminderLoop,
  stopReminderLoop,
  pruneExpired,
};
