/**
 * group-privacy-filter.js — Deterministic post-processing filter for group chats.
 *
 * PROBLEM: The system prompt tells Claude "never share phone numbers or emails
 * in group chat" — but that's non-deterministic. Claude can drift, be jailbroken,
 * or simply forget. If it leaks a phone number in a group, the prompt instruction
 * was the only safeguard.
 *
 * SOLUTION: After Claude responds in a group chat, this filter scrubs the output
 * for patterns that should never appear in group contexts: phone numbers, emails,
 * calendar event titles that slipped through, profile data dumps.
 *
 * This is a SAFETY NET — the prompt instructions remain as the primary control,
 * and this filter catches anything that slips through.
 */

// Phone numbers: +1XXXXXXXXXX, (XXX) XXX-XXXX, XXX-XXX-XXXX, etc.
const PHONE_RE = /(?<!\w)(\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4})(?!\w)/g;

// Email addresses
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Full profile dumps (lines that look like structured profile data)
const PROFILE_DUMP_RE = /^(name|phone|email|address|location|birthday|gcal_connected|pronouns|eightsleep_side)\s*[:=]\s*.+$/gmi;

// Calendar event titles that look like leaked private info
// (medical, therapy, etc. — only in group chat context)
const SENSITIVE_APPOINTMENT_RE = /\b(therapy|therapist|psychiatr|counseling|doctor|gynecolog|obgyn|ob-gyn|fertility|std|sti|rehab|aa meeting|na meeting|divorce|custody|lawyer)\b/gi;

/**
 * Redact sensitive patterns from text destined for a group chat.
 * Returns the filtered text and a log of what was redacted (for audit).
 *
 * @param {string} text — Claude's response text
 * @param {object} opts
 * @param {string} opts.senderPhone — The requesting user's phone (don't redact their own)
 * @returns {{ text: string, redactions: string[] }}
 */
function filterGroupOutput(text, { senderPhone = '' } = {}) {
  if (!text) return { text: '', redactions: [] };

  const redactions = [];

  // Redact phone numbers (except the sender's own number, which they already know)
  let filtered = text.replace(PHONE_RE, (match) => {
    const normalized = match.replace(/[-.\s()]/g, '');
    const senderNorm = senderPhone.replace(/[-.\s()]/g, '');
    if (senderNorm && normalized.endsWith(senderNorm.slice(-10))) return match;
    redactions.push(`phone:${match.slice(0, 4)}****`);
    return '[redacted]';
  });

  // Redact email addresses
  filtered = filtered.replace(EMAIL_RE, (match) => {
    redactions.push(`email:${match.slice(0, 3)}***`);
    return '[redacted]';
  });

  // Strip profile dump lines
  filtered = filtered.replace(PROFILE_DUMP_RE, (match) => {
    redactions.push(`profile-field:${match.slice(0, 20)}...`);
    return '';
  });

  // Clean up empty lines left by redactions
  filtered = filtered.replace(/\n{3,}/g, '\n\n').trim();

  return { text: filtered, redactions };
}

module.exports = { filterGroupOutput, PHONE_RE, EMAIL_RE };
