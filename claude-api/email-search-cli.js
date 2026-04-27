#!/usr/bin/env node
'use strict';

/**
 * CLI utility for reliable email search. Runs server-side Google APIs directly.
 * Claude can call this via Bash when MCP search returns incomplete results.
 *
 * Usage:
 *   node /app/email-search-cli.js search "catherine" --days 30
 *   node /app/email-search-cli.js thread <threadId>
 *   node /app/email-search-cli.js draft --to "email" --subject "Re: ..." --body "message"
 *   node /app/email-search-cli.js draft --to "email" --subject "Re: ..." --body "message" --thread <threadId>
 */

const SIGNAL_OWNER = process.env.SIGNAL_OWNER_NUMBER;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help') {
    console.log('Usage: node email-search-cli.js <search|thread|draft> [options]');
    console.log('  search "query" [--days N]    Search emails (default: 30 days)');
    console.log('  thread <threadId>            Read full email thread');
    console.log('  draft --to X --subject X --body X [--thread X]  Create draft');
    process.exit(0);
  }

  const googleAuth = require('./google-auth');
  const gmail = await googleAuth.getGmailClient(SIGNAL_OWNER);
  if (!gmail) {
    console.error('Gmail not connected. Run !connect to authorize.');
    process.exit(1);
  }

  if (command === 'search') {
    await searchEmails(gmail, args.slice(1));
  } else if (command === 'thread') {
    await readThread(gmail, args[1]);
  } else if (command === 'draft') {
    await createDraft(gmail, args.slice(1));
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

function getFlag(args, flag, defaultValue = null) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return defaultValue;
  return args[idx + 1];
}

async function searchEmails(gmail, args) {
  const query = args.find(a => !a.startsWith('--')) || '';
  const days = parseInt(getFlag(args, '--days', '30'), 10);

  if (!query) {
    console.error('Usage: search "query" [--days N]');
    process.exit(1);
  }

  const afterEpoch = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

  // Multiple search strategies for thorough results
  const queries = [
    `${query} after:${afterEpoch}`,
    `from:${query} after:${afterEpoch}`,
    `subject:${query} after:${afterEpoch}`,
  ];

  const seenIds = new Set();
  const allMsgRefs = [];

  for (const q of queries) {
    try {
      const listRes = await gmail.users.messages.list({
        userId: 'me', q, maxResults: 20,
      });
      for (const msg of (listRes.data.messages || [])) {
        if (!seenIds.has(msg.id)) {
          seenIds.add(msg.id);
          allMsgRefs.push(msg);
        }
      }
    } catch {}
  }

  if (allMsgRefs.length === 0) {
    console.log(`No emails found for "${query}" in the last ${days} days.`);
    return;
  }

  // Fetch metadata
  const results = await Promise.all(
    allMsgRefs.slice(0, 30).map(async ({ id, threadId }) => {
      try {
        const msg = await gmail.users.messages.get({
          userId: 'me', id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });
        const headers = msg.data.payload?.headers || [];
        const h = (name) => headers.find(hdr => hdr.name.toLowerCase() === name.toLowerCase())?.value || '';
        return { messageId: id, threadId, from: h('From'), to: h('To'), subject: h('Subject'), date: h('Date'), snippet: msg.data.snippet || '', isUnread: (msg.data.labelIds || []).includes('UNREAD') };
      } catch { return null; }
    })
  );

  const valid = results.filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));
  console.log(`Found ${valid.length} email(s) for "${query}":\n`);
  for (let i = 0; i < valid.length; i++) {
    const e = valid[i];
    const fromShort = (e.from.match(/^(.+?)\s*</) || [])[1]?.replace(/["']/g, '') || e.from.split('@')[0];
    const dateStr = new Date(e.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    console.log(`${i + 1}. ${fromShort} — "${e.subject}" (${dateStr})${e.isUnread ? ' [UNREAD]' : ''}`);
    console.log(`   threadId: ${e.threadId}  messageId: ${e.messageId}`);
    if (e.snippet) console.log(`   ${e.snippet.substring(0, 120)}`);
    console.log('');
  }
}

async function readThread(gmail, threadId) {
  if (!threadId) {
    console.error('Usage: thread <threadId>');
    process.exit(1);
  }

  const thread = await gmail.users.threads.get({
    userId: 'me', id: threadId, format: 'full',
  });

  for (const msg of (thread.data.messages || [])) {
    const headers = msg.payload?.headers || [];
    const h = (name) => headers.find(hdr => hdr.name.toLowerCase() === name.toLowerCase())?.value || '';

    let body = '';
    function extractText(part) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body += Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts) part.parts.forEach(extractText);
    }
    if (msg.payload) extractText(msg.payload);

    const fromShort = (h('From').match(/^(.+?)\s*</) || [])[1]?.replace(/["']/g, '') || h('From');
    const dateStr = new Date(h('Date')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    console.log(`--- ${fromShort} (${dateStr}) ---`);
    console.log(`Subject: ${h('Subject')}`);
    console.log(`To: ${h('To')}`);
    console.log('');
    console.log(body.trim().substring(0, 3000));
    console.log('\n');
  }
}

async function createDraft(gmail, args) {
  const to = getFlag(args, '--to');
  const subject = getFlag(args, '--subject', '(no subject)');
  const body = getFlag(args, '--body');
  const threadId = getFlag(args, '--thread');

  if (!to || !body) {
    console.error('Usage: draft --to <email> --body <message> [--subject <subject>] [--thread <threadId>]');
    process.exit(1);
  }

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');

  const draftBody = { message: { raw } };
  if (threadId) draftBody.message.threadId = threadId;

  const draft = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: draftBody,
  });

  console.log(`Draft saved (ID: ${draft.data.id}) — "${subject}" to ${to}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
