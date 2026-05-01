'use strict';

const approvalGate = require('../approval-gate');

module.exports = {
  name: 'unsub',
  description: 'Manage newsletter unsubscribe suggestions',
  ownerOnly: false,
  usage: '!unsub scan [days] | !unsub yes <number|all> | !unsub list | !unsub clear',

  async run(message, arg, state, ctx) {
    const parts = (arg || '').trim().split(/\s+/);
    const subcommand = (parts[0] || '').toLowerCase();
    const senderId = message.senderId || message.author?.id;

    if (subcommand === 'scan') {
      const days = parseInt(parts[1], 10) || 30;
      try {
        const { analyzeNewsletters } = require('../newsletter-analyzer');
        const candidates = await analyzeNewsletters(senderId, days);
        if (!candidates || candidates.length === 0) {
          return ctx.reply('No newsletter unsubscribe candidates found.');
        }
        const actions = candidates.slice(0, 10).map(c => ({
          label: `${c.sender} (${c.count} emails, ${Math.round(c.unreadRate * 100)}% unread)`,
          meta: { sender: c.sender, domain: c.domain, messageId: c.latestMessageId },
        }));
        approvalGate.proposePending(senderId, 'unsub', actions);
        const lines = actions.map((a, i) => `${i + 1}. ${a.label}`);
        return ctx.reply(
          `📧 **Unsubscribe candidates (last ${days} days):**\n${lines.join('\n')}\n\nReply \`!unsub yes <number>\` to unsubscribe, or \`!unsub yes all\` for all.`
        );
      } catch (e) {
        return ctx.reply(`Error scanning: ${e.message}`);
      }
    }

    if (subcommand === 'yes') {
      const target = parts[1];
      if (!target) return ctx.reply('Usage: `!unsub yes <number|all>`');

      const result = approvalGate.approvePending(senderId, 'unsub', target === 'all' ? 'all' : parseInt(target, 10));
      if (!result || result.notFound) return ctx.reply('No pending unsubscribe suggestions. Run `!unsub scan` first.');

      const approved = result.approved || [];
      if (approved.length === 0) return ctx.reply('Nothing to approve.');

      // Execute each approved unsubscribe
      const { unsubscribe, getGmailClient } = require('../gmail-client');
      const gmail = await getGmailClient(senderId);
      if (!gmail) return ctx.reply('Gmail not connected. Use `!connect` first.');

      const results = [];
      for (const id of approved) {
        const approval = approvalGate.consumeApproval(senderId, 'unsub', m => {
          const pending = approvalGate.getPending(senderId, 'unsub');
          const item = pending?.find(p => p.id === id);
          return item && m.sender === item.meta.sender;
        });
        if (!approval) continue;
        try {
          const res = await unsubscribe(gmail, approval.messageId);
          results.push(res.success ? `✅ ${approval.sender}` : `⚠️ ${approval.sender}: ${res.detail}`);
          // Audit
          try {
            const fs = require('fs');
            const path = require('path');
            const auditPath = path.join('/app/data', 'unsub-audit.json');
            let audit = [];
            try { audit = JSON.parse(fs.readFileSync(auditPath, 'utf8')); } catch {}
            audit.push({ ts: new Date().toISOString(), userId: senderId, sender: approval.sender, ...res });
            fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
          } catch {}
        } catch (e) {
          results.push(`❌ ${approval.sender}: ${e.message}`);
        }
      }
      return ctx.reply(results.join('\n') || 'No unsubscribes executed.');
    }

    if (subcommand === 'list') {
      const pending = approvalGate.getPending(senderId, 'unsub');
      if (!pending || pending.length === 0) return ctx.reply('No pending suggestions. Run `!unsub scan` first.');
      const lines = pending.map(p => `${p.id}. ${p.approved ? '✅' : '⬜'} ${p.label}`);
      return ctx.reply(`**Pending unsubscribes:**\n${lines.join('\n')}`);
    }

    if (subcommand === 'clear') {
      approvalGate.clearPending(senderId, 'unsub');
      return ctx.reply('Cleared all pending unsubscribe suggestions.');
    }

    return ctx.reply('Usage: `!unsub scan [days]` · `!unsub yes <number|all>` · `!unsub list` · `!unsub clear`');
  },
};
