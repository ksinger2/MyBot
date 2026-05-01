const { fetchRecentEmailMetadata, getGmailClient } = require('./gmail-client');

/**
 * Analyze a user's Gmail to find newsletter/marketing senders that are
 * good candidates for unsubscribing.
 *
 * @param {string} userId - Discord (or platform) user ID
 * @param {number} daysBack - How many days of email to analyze (default 30)
 * @returns {Promise<Array<{
 *   sender: string,
 *   domain: string,
 *   count: number,
 *   unreadCount: number,
 *   unreadRate: number,
 *   hasUnsubscribe: boolean,
 *   sampleSubjects: string[],
 *   latestMessageId: string,
 *   score: number
 * }>>} Ranked array of unsubscribe candidates (highest score first)
 */
async function analyzeNewsletters(userId, daysBack = 30) {
  const gmail = await getGmailClient(userId);
  if (!gmail) return [];

  const hoursBack = daysBack * 24;
  const emails = await fetchRecentEmailMetadata(gmail, hoursBack);
  if (!emails.length) return [];

  // Group emails by sender address
  const senderMap = new Map();

  for (const email of emails) {
    const sender = parseSenderAddress(email.from);
    if (!sender) continue;

    if (!senderMap.has(sender)) {
      senderMap.set(sender, {
        sender,
        domain: extractDomain(sender),
        emails: [],
      });
    }

    senderMap.get(sender).emails.push(email);
  }

  // Build candidate list — only senders with 3+ emails (filters out human 1:1 messages)
  const candidates = [];

  for (const group of senderMap.values()) {
    if (group.emails.length < 3) continue;

    const count = group.emails.length;
    const unreadCount = group.emails.filter(e => e.isUnread).length;
    const unreadRate = count > 0 ? unreadCount / count : 0;
    const hasUnsubscribe = group.emails.some(e => !!e.unsubscribeHeader);

    // Collect up to 3 unique sample subjects
    const seenSubjects = new Set();
    const sampleSubjects = [];
    for (const e of group.emails) {
      const subj = e.subject || '(no subject)';
      if (!seenSubjects.has(subj) && sampleSubjects.length < 3) {
        seenSubjects.add(subj);
        sampleSubjects.push(subj);
      }
    }

    // Latest message by array position (fetchRecentEmailMetadata returns newest first)
    const latestMessageId = group.emails[0].messageId;

    const score = computeScore(count, unreadRate, hasUnsubscribe);

    candidates.push({
      sender: group.sender,
      domain: group.domain,
      count,
      unreadCount,
      unreadRate: Math.round(unreadRate * 100) / 100,
      hasUnsubscribe,
      sampleSubjects,
      latestMessageId,
      score,
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

/**
 * Compute an unsubscribe-candidate score (0-100).
 *
 * - Base: frequency score — (count / 30) normalized to 0-40, capped at 40
 * - +30 if unreadRate > 0.7 (user rarely reads these)
 * - +20 if hasUnsubscribe header (easy to unsubscribe)
 * - +10 if count > 10 (high volume)
 */
function computeScore(count, unreadRate, hasUnsubscribe) {
  // Frequency: count/30 * 40, capped at 40
  const frequencyScore = Math.min((count / 30) * 40, 40);

  let score = frequencyScore;

  if (unreadRate > 0.7) score += 30;
  if (hasUnsubscribe) score += 20;
  if (count > 10) score += 10;

  return Math.min(Math.round(score), 100);
}

/**
 * Extract the bare email address from a From header value.
 * Handles formats like:
 *   "Display Name <user@example.com>"
 *   user@example.com
 */
function parseSenderAddress(from) {
  if (!from) return null;
  const match = from.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  // Bare address
  const trimmed = from.trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : null;
}

/**
 * Extract domain from an email address.
 */
function extractDomain(email) {
  const parts = email.split('@');
  return parts.length === 2 ? parts[1] : email;
}

module.exports = { analyzeNewsletters };
