/**
 * owner-output-filter.js — Deterministic post-processing filter for owner DM responses.
 *
 * PROBLEM: Group chats have group-privacy-filter.js that deterministically scrubs
 * sensitive data from responses. But owner DM sessions rely purely on prompt
 * instructions ("NEVER output secrets") — this violates the Determinism Rule.
 *
 * SOLUTION: After Claude responds in an owner DM, this filter scrubs the output
 * for patterns that should never appear in chat messages: API keys, env variable
 * dumps, paths to sensitive files, and phone numbers (middle digits redacted).
 *
 * This is a SAFETY NET — the prompt instructions remain as the primary control,
 * and this filter catches anything that slips through.
 */

const { scrubSecrets } = require('./runner');

// ── Phone numbers: redact middle digits, preserve first 3 and last 2 ──
// Matches +1XXXXXXXXXX, (XXX) XXX-XXXX, XXX-XXX-XXXX, etc.
const PHONE_RE = /(?<!\w)(\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4})(?!\w)/g;

// ── Environment variable dump lines: export KEY=value or KEY=value ──
const KNOWN_SECRET_NAMES = [
  'INTERNAL_API_TOKEN', 'TOKEN_ENCRYPTION_KEY', 'BOT_UNLOCK_PIN',
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GH_TOKEN', 'SERPAPI_KEY',
  'SPOTIFY_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET', 'ELEVENLABS_API_KEY',
  'REPLICATE_API_TOKEN', 'STRIPE_SECRET_KEY', 'VIDEO_GEN_API_KEY',
  'DISCORD_BOT_TOKEN', 'SIGNAL_OWNER_NUMBER', 'TICKETMASTER_API_KEY',
];
const ENV_DUMP_RE = new RegExp(
  `(?:^|\\n)\\s*(?:export\\s+)?(?:${KNOWN_SECRET_NAMES.join('|')})\\s*=\\s*\\S+`,
  'gm'
);

// ── Sensitive file paths ──
const SENSITIVE_FILE_RE = /(?:\/[\w./-]*)?(?:\.env(?:\.\w+)?|credentials\.json|\.claude\.json|user-tokens\.json|service-account\.json|\.npmrc|\.netrc|id_rsa|id_ed25519|\.pem)(?=[\s"'`,;)\]}]|$)/gi;

/**
 * Redact sensitive patterns from text destined for an owner DM.
 * Returns the filtered text and a log of what was redacted (for audit).
 *
 * @param {string} text — Claude's response text
 * @returns {{ text: string, redactions: string[] }}
 */
function filterOwnerOutput(text) {
  if (!text) return { text: '', redactions: [] };

  const redactions = [];

  // Step 1: Apply the same scrubSecrets() used on all runner output.
  // This catches API key patterns, Bearer tokens, sk-* keys, JSON secrets, etc.
  let filtered = scrubSecrets(text);
  // Count how many [REDACTED] markers were added by scrubSecrets
  const origRedactedCount = (text.match(/\[REDACTED\]/g) || []).length;
  const newRedactedCount = (filtered.match(/\[REDACTED\]/g) || []).length;
  const scrubCount = newRedactedCount - origRedactedCount;
  if (scrubCount > 0) {
    redactions.push(`secrets:${scrubCount}`);
  }

  // Step 2: Redact env variable dump lines
  filtered = filtered.replace(ENV_DUMP_RE, (match) => {
    const key = match.trim().replace(/^export\s+/, '').split('=')[0];
    redactions.push(`env-dump:${key}`);
    return `\n${key}=[REDACTED]`;
  });

  // Step 3: Redact paths to sensitive files
  filtered = filtered.replace(SENSITIVE_FILE_RE, (match) => {
    redactions.push(`sensitive-path:${match.split('/').pop()}`);
    return '[sensitive-file-redacted]';
  });

  // Step 4: Redact phone numbers — keep first 3 and last 2 digits, mask the middle
  filtered = filtered.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 7) return match; // too short to be a real phone number
    const prefix = digits.slice(0, 3);
    const suffix = digits.slice(-2);
    const masked = prefix + '*'.repeat(digits.length - 5) + suffix;
    redactions.push(`phone:${prefix}****${suffix}`);
    return masked;
  });

  return { text: filtered, redactions };
}

module.exports = { filterOwnerOutput };
