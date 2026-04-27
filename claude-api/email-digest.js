const Anthropic = require('@anthropic-ai/sdk');
const { getGmailClient, fetchRecentEmailMetadata } = require('./gmail-client');

// Short-lived session map: userId → { emails: [...], unsubscribeCandidates: [...], expiresAt }
// TTL 2h — gives user time to act on digest actions after receiving it
const _digestSessions = new Map();
const DIGEST_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function saveDigestSession(userId, emails, unsubscribeCandidates) {
  _digestSessions.set(userId, {
    emails,
    unsubscribeCandidates,
    expiresAt: Date.now() + DIGEST_SESSION_TTL_MS,
  });
}

function getDigestSession(userId) {
  const s = _digestSessions.get(userId);
  if (!s || Date.now() > s.expiresAt) {
    _digestSessions.delete(userId);
    return null;
  }
  return s;
}

// Prune stale sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _digestSessions.entries()) {
    if (now > v.expiresAt) _digestSessions.delete(k);
  }
}, 60 * 60 * 1000).unref();

/**
 * Fetch emails and generate a categorized digest for the given userId.
 * Returns the formatted Signal message string.
 */
async function generateEmailDigest(userId, hoursBack = 24) {
  const gmailClient = await getGmailClient(userId);
  if (!gmailClient) {
    return "I'm not connected to your Gmail yet. Run `!connect` to authorize, then try again.";
  }

  const emails = await fetchRecentEmailMetadata(gmailClient, hoursBack);
  if (!emails.length) {
    return `📬 No emails in the last ${hoursBack} hours. Inbox zero! 🎉`;
  }

  const categorized = await _categorizeEmails(emails);

  // Merge categorized items back with original emails to preserve messageId/isUnread.
  // Claude returns { from, subject, reason } — we need the full email object for actions.
  const allCategorized = [
    ...(categorized.important || []).map(e => ({ ...e, _cat: 'important' })),
    ...(categorized.reply || []).map(e => ({ ...e, _cat: 'reply' })),
    ...(categorized.unsubscribe || []).map(e => ({ ...e, _cat: 'unsubscribe' })),
    ...(categorized.ignore || []).map(e => ({ ...e, _cat: 'ignore' })),
  ];
  const allIndexed = allCategorized.map((e, i) => {
    const original = emails.find(m => m.subject === e.subject && m.from === e.from) || {};
    return { ...original, ...e, shortId: i + 1 };
  });

  const unsubCandidates = allIndexed.filter(e => e._cat === 'unsubscribe');

  saveDigestSession(userId, allIndexed, unsubCandidates);

  return _formatDigest(categorized, emails.length, allIndexed);
}

const IGNORE_PATTERNS = [
  /noreply|no-reply|donotreply|do-not-reply/i,
  /notification|alert|digest|newsletter|update.*account/i,
  /receipt|order.*confirm|shipping|tracking|delivery/i,
  /verify.*email|verification|2fa|one-time|security code/i,
  /unsubscribe|manage.*preferences|email.*preferences/i,
  /calendar.*notification|event.*reminder|invitation/i,
  /social.*media|facebook|twitter|instagram|linkedin.*notification/i,
];

const UNSUB_PATTERNS = [
  /newsletter|digest|weekly|daily.*update|roundup/i,
  /marketing|promo|deal|sale|offer|discount|coupon/i,
  /subscription|subscribe|mailing.*list/i,
];

const IMPORTANT_PATTERNS = [
  /product.*manager|PM.*role|head.*product|director.*product|UX/i,
  /job.*offer|job.*opportunity|application.*status|interview|hiring/i,
  /offer.*letter|compensation|onsite|phone.*screen/i,
  /urgent|action.*required|deadline|time.*sensitive/i,
];

function _categorizeEmailsRuleBased(emails) {
  const cats = { important: [], reply: [], unsubscribe: [], ignore: [] };

  for (const e of emails) {
    const text = `${e.from} ${e.subject} ${e.snippet || ''}`;
    const entry = { from: e.from, subject: e.subject, reason: '' };

    if (IMPORTANT_PATTERNS.some(p => p.test(text))) {
      entry.reason = 'Job/career related';
      cats.important.push(entry);
    } else if (UNSUB_PATTERNS.some(p => p.test(text))) {
      entry.reason = 'Newsletter/marketing';
      cats.unsubscribe.push(entry);
    } else if (IGNORE_PATTERNS.some(p => p.test(text))) {
      entry.reason = 'Automated notification';
      cats.ignore.push(entry);
    } else if (e.isUnread && !IGNORE_PATTERNS.some(p => p.test(e.from || ''))) {
      entry.reason = 'Unread from real sender';
      cats.reply.push(entry);
    } else {
      cats.ignore.push(entry);
    }
  }

  return cats;
}

async function _categorizeEmails(emails) {
  // Try AI categorization first, fall back to rules if API unavailable
  try {
    const client = new Anthropic();
    const emailList = emails.map((e, i) =>
      `${i + 1}. From: ${e.from}\n   Subject: ${e.subject}\n   Preview: ${e.snippet?.slice(0, 120) || ''}`
    ).join('\n\n');

    const systemPrompt = `You are an email organizer for Karen, a product manager actively looking for Product Manager jobs.

Categorize each email into exactly one of these groups:
- IMPORTANT: Job listings (Product Manager, PM, Head of Product, Director of Product, UX, etc.), messages from real people that matter, time-sensitive info
- REPLY: Messages from real humans that ask questions, need a response, or are part of ongoing conversations
- UNSUBSCRIBE: Newsletters, marketing emails, promotional content, digest emails Karen doesn't need
- IGNORE: Automated alerts, receipts, shipping notifications, 2FA codes, calendar notifications, social media alerts

Respond ONLY with valid JSON in this exact format (no other text):
{
  "important": [{"from": "...", "subject": "...", "reason": "..."}],
  "reply": [{"from": "...", "subject": "...", "reason": "..."}],
  "unsubscribe": [{"from": "...", "subject": "...", "reason": "..."}],
  "ignore": [{"from": "...", "subject": "...", "reason": "..."}]
}`;

    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Categorize these ${emails.length} emails:\n\n${emailList}` }],
    });

    const text = resp.content?.[0]?.text;
    if (!text) throw new Error('empty response from Claude');
    return JSON.parse(text);
  } catch (err) {
    console.warn(`[email-digest] AI categorization failed (${err.message}), using rule-based fallback`);
    return _categorizeEmailsRuleBased(emails);
  }
}

function _formatDigest(cats, total, allIndexed) {
  const lines = [`📬 Morning email digest — ${total} email${total === 1 ? '' : 's'}\n`];

  const section = (emoji, label, items) => {
    if (!items.length) return;
    lines.push(`${emoji} ${label} (${items.length})`);
    for (const e of items) {
      const shortId = allIndexed.find(x => x.subject === e.subject && x.from === e.from)?.shortId;
      const idStr = shortId ? `[${shortId}] ` : '';
      const fromShort = _shortFrom(e.from);
      lines.push(`• ${idStr}${fromShort}: "${e.subject?.slice(0, 60) || '(no subject)'}"${e.reason ? ` — ${e.reason}` : ''}`);
    }
    lines.push('');
  };

  section('⭐', 'IMPORTANT', cats.important || []);
  section('↩️', 'NEEDS REPLY', cats.reply || []);
  section('📤', 'UNSUBSCRIBE', cats.unsubscribe || []);
  section('🙈', 'IGNORE', cats.ignore || []);

  const unsubCount = (cats.unsubscribe || []).length;
  if (unsubCount > 0) {
    lines.push(`To unsubscribe from all flagged: \`!emaildigest unsubscribe all\``);
    lines.push(`To mark all read: \`!emaildigest markread all\``);
  }

  return lines.join('\n').trim();
}

function _shortFrom(from) {
  // "First Last <email@domain.com>" → "First Last"
  const nameMatch = from?.match(/^(.+?)\s*</);
  if (nameMatch) return nameMatch[1].replace(/^["']|["']$/g, '').trim();
  // bare email → domain
  const emailMatch = from?.match(/@([^>]+)/);
  if (emailMatch) return emailMatch[1].split('.')[0];
  return (from || 'Unknown').slice(0, 30);
}

/**
 * Scheduler entry point — called by scheduler.js for subtype 'email-digest'.
 */
async function runEmailDigestJob(sched) {
  if (!sched.userId) {
    console.warn(`[email-digest] Job #${sched.id} has no userId, skipping`);
    return;
  }

  console.log(`[email-digest] Running digest job #${sched.id} for ${sched.userId}`);

  const text = await generateEmailDigest(sched.userId, 24);

  const { signalAdapter } = require('./bot');
  if (signalAdapter && signalAdapter.ready) {
    await signalAdapter.sendLongMessage(sched.userId, text);
  } else {
    console.warn(`[email-digest] Job #${sched.id} — Signal adapter not ready`);
  }
}

module.exports = { generateEmailDigest, runEmailDigestJob, getDigestSession, saveDigestSession };
