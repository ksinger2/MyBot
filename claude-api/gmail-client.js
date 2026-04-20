const https = require('https');
const http = require('http');
const url = require('url');
const { getGmailClient } = require('./google-auth');

const MAX_EMAILS = 100;

/**
 * Fetch metadata for emails received in the last N hours.
 * Returns array of { messageId, threadId, from, subject, snippet, date, labels, unsubscribeHeader }
 */
async function fetchRecentEmailMetadata(gmail, hoursBack = 24) {
  const after = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${after}`,
    maxResults: MAX_EMAILS,
  });

  const messages = listRes.data.messages || [];
  if (!messages.length) return [];

  // Batch-fetch metadata for all messages
  const results = await Promise.all(
    messages.map(async ({ id, threadId }) => {
      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date', 'List-Unsubscribe', 'List-Unsubscribe-Post'],
        });

        const headers = msg.data.payload?.headers || [];
        const h = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        return {
          messageId: id,
          threadId,
          from: h('From'),
          subject: h('Subject'),
          snippet: msg.data.snippet || '',
          date: h('Date'),
          labels: msg.data.labelIds || [],
          unsubscribeHeader: h('List-Unsubscribe'),
          unsubscribePost: h('List-Unsubscribe-Post'),
          isUnread: (msg.data.labelIds || []).includes('UNREAD'),
        };
      } catch (err) {
        console.warn(`[gmail-client] Failed to fetch metadata for message ${id}: ${err.message}`);
        return null;
      }
    })
  );

  return results.filter(Boolean);
}

/**
 * Mark a message as read.
 */
async function markRead(gmail, messageId) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

/**
 * Mark a message as unread.
 */
async function markUnread(gmail, messageId) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: ['UNREAD'] },
  });
}

/**
 * Attempt to unsubscribe using the List-Unsubscribe header.
 * Tries one-click POST first, falls back to GET, then mailto:.
 * Returns { method: 'http'|'mailto'|'none', success: boolean, detail: string }
 */
async function unsubscribe(gmail, messageId) {
  // Fetch full headers to get List-Unsubscribe
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['List-Unsubscribe', 'List-Unsubscribe-Post'],
  });

  const headers = msg.data.payload?.headers || [];
  const h = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  const unsubHeader = h('List-Unsubscribe');
  const unsubPost = h('List-Unsubscribe-Post');

  if (!unsubHeader) return { method: 'none', success: false, detail: 'No List-Unsubscribe header' };

  // Parse all URLs and mailto: from header (may contain multiple comma-separated values)
  const parts = unsubHeader.split(',').map(s => s.trim().replace(/^<|>$/g, ''));
  const httpUrl = parts.find(p => p.startsWith('http'));
  const mailtoAddr = parts.find(p => p.startsWith('mailto:'));

  // Reject internal/private URLs before making any outbound request
  if (httpUrl && !_isSafeExternalUrl(httpUrl)) {
    return { method: 'none', success: false, detail: 'Blocked: List-Unsubscribe URL is not an external address' };
  }

  // One-click HTTP POST (RFC 8058)
  if (httpUrl && unsubPost && unsubPost.toLowerCase().includes('list-unsubscribe=one-click')) {
    try {
      await _httpPost(httpUrl, 'List-Unsubscribe=One-Click');
      return { method: 'http', success: true, detail: `POST to ${_shortUrl(httpUrl)}` };
    } catch (err) {
      // Fall through to GET
    }
  }

  // HTTP GET
  if (httpUrl) {
    try {
      await _httpGet(httpUrl);
      return { method: 'http', success: true, detail: `GET ${_shortUrl(httpUrl)}` };
    } catch (err) {
      return { method: 'http', success: false, detail: err.message };
    }
  }

  // mailto: — send a blank email to the unsubscribe address
  if (mailtoAddr) {
    try {
      const parsed = new url.URL(mailtoAddr);
      const to = parsed.pathname;
      const subject = parsed.searchParams.get('subject') || 'Unsubscribe';
      const raw = _buildRawEmail(to, subject);
      await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });
      return { method: 'mailto', success: true, detail: `Sent to ${to}` };
    } catch (err) {
      return { method: 'mailto', success: false, detail: err.message };
    }
  }

  return { method: 'none', success: false, detail: 'No usable unsubscribe method' };
}

// Block SSRF: reject URLs pointing at localhost or RFC-1918 private addresses.
// An attacker can craft a List-Unsubscribe header pointing at internal services.
function _isSafeExternalUrl(targetUrl) {
  try {
    const parsed = new url.URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const h = parsed.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    // RFC-1918 and link-local ranges
    if (/^10\./.test(h)) return false;
    if (/^192\.168\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (/^169\.254\./.test(h)) return false; // AWS/GCP metadata
    if (/^fd[0-9a-f]{2}:/i.test(h)) return false; // IPv6 ULA
    return true;
  } catch { return false; }
}

function _shortUrl(u) {
  try { return new url.URL(u).hostname; } catch { return u.slice(0, 40); }
}

function _buildRawEmail(to, subject) {
  const msg = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Unsubscribe',
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

function _httpPost(targetUrl, body) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = lib.request(opts, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function _httpGet(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = { fetchRecentEmailMetadata, markRead, markUnread, unsubscribe, getGmailClient };
