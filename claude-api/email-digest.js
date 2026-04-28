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

  saveDigestSession(userId, allIndexed, []);

  return _formatDigest(categorized, emails.length);
}

const AUTOMATED_SENDER_PATTERNS = [
  /noreply|no-reply|donotreply|do-not-reply/i,
  /notifications?@|alerts?@|updates?@|digest@|mailer-daemon/i,
  /support@|billing@|receipts?@|orders?@|shipping@|tracking@/i,
  /calendar-notification|googleusercontent\.com/i,
];

const AUTOMATED_SUBJECT_PATTERNS = [
  /receipt|order.*confirm|shipping|tracking|delivery/i,
  /verify.*email|verification|2fa|one-time|security code/i,
  /calendar.*notification|event.*reminder/i,
  /notification|alert|your.*account|password.*reset/i,
  /social.*media|facebook|twitter|instagram|linkedin.*notification/i,
];

const NEWSLETTER_PATTERNS = [
  /newsletter|digest|weekly|daily.*update|roundup/i,
  /marketing|promo|deal|sale|offer|discount|coupon/i,
  /subscription|mailing.*list/i,
];

const JOB_PATTERNS = [
  /product.*manager|PM.*role|head.*product|director.*product|UX/i,
  /job.*offer|job.*opportunity|application.*status|interview|hiring/i,
  /offer.*letter|compensation|onsite|phone.*screen/i,
  /recruiter|talent.*acquisition|we.*reviewed.*your/i,
];

function _isAutomatedSender(from) {
  return AUTOMATED_SENDER_PATTERNS.some(p => p.test(from || ''));
}

function _isRealPerson(email) {
  if (_isAutomatedSender(email.from)) return false;
  if (email.unsubscribeHeader) return false;
  if (AUTOMATED_SUBJECT_PATTERNS.some(p => p.test(email.subject || ''))) return false;
  if (NEWSLETTER_PATTERNS.some(p => p.test(`${email.from} ${email.subject}`))) return false;
  return true;
}

function _categorizeEmailsRuleBased(emails) {
  const cats = { important: [], reply: [], unsubscribe: [], ignore: [] };

  for (const e of emails) {
    const text = `${e.from} ${e.subject} ${e.snippet || ''}`;
    const entry = { from: e.from, subject: e.subject, reason: '' };
    const labels = e.labels || [];

    const isStarred = labels.includes('STARRED');
    const isImportant = labels.includes('IMPORTANT');
    const isJobRelated = JOB_PATTERNS.some(p => p.test(text));
    const isPersonal = _isRealPerson(e);

    if (isJobRelated) {
      entry.reason = 'Job/career';
      cats.important.push(entry);
    } else if (isStarred) {
      entry.reason = 'Starred';
      cats.important.push(entry);
    } else if (isImportant && isPersonal) {
      entry.reason = 'Marked important';
      cats.important.push(entry);
    } else if (isPersonal && e.isUnread) {
      entry.reason = 'Direct message';
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

    const systemPrompt = `You are an email triage assistant. Only surface emails that actually matter.

Categorize each email into exactly one group:
- IMPORTANT: Direct emails from a real person, job/career related (PM, product, UX, recruiter), starred, or marked important. Also urgent/time-sensitive items.
- REPLY: Unread messages from real humans (not companies/services) that need a response.
- IGNORE: Everything else — newsletters, marketing, automated notifications, receipts, alerts, social media, mailing lists, any email with an unsubscribe link that isn't from a real person.

Be aggressive about filtering. Most emails are noise. Only important and reply matter.

Respond ONLY with valid JSON (no other text):
{
  "important": [{"from": "...", "subject": "...", "reason": "..."}],
  "reply": [{"from": "...", "subject": "...", "reason": "..."}],
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

function _formatDigest(cats, total) {
  const important = cats.important || [];
  const reply = cats.reply || [];
  const ignored = (cats.ignore || []).length;

  const actionable = important.length + reply.length;
  if (actionable === 0) {
    return `📬 **Email** — ${total} emails, nothing actionable. ${ignored} filtered out.`;
  }

  const lines = [`📬 **Email** — ${actionable} actionable out of ${total}\n`];

  if (important.length) {
    lines.push(`⭐ **Important** (${important.length})`);
    for (const e of important.slice(0, 5)) {
      lines.push(`• ${_shortFrom(e.from)}: ${e.subject?.slice(0, 50) || '(no subject)'}${e.reason ? ` — ${e.reason}` : ''}`);
    }
    if (important.length > 5) lines.push(`  …and ${important.length - 5} more`);
    lines.push('');
  }

  if (reply.length) {
    lines.push(`↩️ **Direct messages** (${reply.length})`);
    for (const e of reply.slice(0, 5)) {
      lines.push(`• ${_shortFrom(e.from)}: ${e.subject?.slice(0, 50) || '(no subject)'}`);
    }
    if (reply.length > 5) lines.push(`  …and ${reply.length - 5} more`);
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
