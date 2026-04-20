module.exports = {
  name: '!emaildigest',
  aliases: ['!ed'],
  adminOnly: true,
  description: 'Morning email digest — read, categorize, mark read, unsubscribe',
  async run(message, arg, state, ctx) {
    const { generateEmailDigest, getDigestSession } = require('../email-digest');
    const { getGmailClient, markRead, markUnread, unsubscribe } = require('../gmail-client');

    const userId = message.author.id;
    const args = (arg || '').trim().split(/\s+/);
    const sub = args[0]?.toLowerCase();

    // ── !emaildigest schedule [time] ─────────────────────────────────────────
    if (sub === 'schedule') {
      const timeArg = args.slice(1).join(' ') || '8am';
      const parsed = ctx.parseFrequency(`daily at ${timeArg}`);
      if (!parsed) {
        await message.reply(`Couldn't parse time "${timeArg}". Try: \`!emaildigest schedule 8am\``);
        return;
      }
      const sched = ctx.addSchedule({
        userId,
        channelId: message.channel.id,
        message: 'email digest',
        cronRule: parsed.cron,
        description: parsed.description || `Daily email digest at ${timeArg}`,
        timezone: 'America/Los_Angeles',
        type: 'dm-task',
        subtype: 'email-digest',
      });
      ctx.registerJob(sched, ctx.client);
      await message.reply(`Scheduled daily email digest at ${timeArg} PT. Use \`!schedules\` to see it, \`!unschedule ${sched.id}\` to remove.`);
      return;
    }

    // ── !emaildigest off ─────────────────────────────────────────────────────
    if (sub === 'off') {
      const { getUserSchedules, removeSchedule } = require('../schedules-storage');
      const { cancelJob } = require('../scheduler');
      const scheds = getUserSchedules(userId).filter(s => s.subtype === 'email-digest' && s.active);
      if (!scheds.length) {
        await message.reply('No active email digest schedules found.');
        return;
      }
      for (const s of scheds) {
        removeSchedule(s.id, userId);
        try { cancelJob(s.id); } catch {}
      }
      await message.reply(`Cancelled ${scheds.length} email digest schedule(s).`);
      return;
    }

    // ── !emaildigest markread [all | <id>] ───────────────────────────────────
    if (sub === 'markread') {
      const gmailClient = await getGmailClient(userId);
      if (!gmailClient) {
        await message.reply("Not connected to Gmail. Run `!connect` first.");
        return;
      }
      const session = getDigestSession(userId);
      if (!session) {
        await message.reply("No active digest session. Run `!emaildigest` first.");
        return;
      }
      const target = args[1]?.toLowerCase();
      let toMark = [];
      if (target === 'all') {
        toMark = session.emails.filter(e => e.isUnread);
      } else {
        const id = parseInt(target, 10);
        const found = session.emails.find(e => e.shortId === id);
        if (!found) { await message.reply(`Email #${target} not found. Run \`!emaildigest\` to get fresh IDs.`); return; }
        toMark = [found];
      }
      if (!toMark.length) { await message.reply('Nothing to mark — all already read.'); return; }
      await Promise.all(toMark.map(e => markRead(gmailClient, e.messageId).catch(() => {})));
      await message.reply(`Marked ${toMark.length} email${toMark.length === 1 ? '' : 's'} as read.`);
      return;
    }

    // ── !emaildigest markunread <id> ─────────────────────────────────────────
    if (sub === 'markunread') {
      const gmailClient = await getGmailClient(userId);
      if (!gmailClient) {
        await message.reply("Not connected to Gmail. Run `!connect` first.");
        return;
      }
      const session = getDigestSession(userId);
      if (!session) { await message.reply("No active digest session. Run `!emaildigest` first."); return; }
      const id = parseInt(args[1], 10);
      const found = session.emails.find(e => e.shortId === id);
      if (!found) { await message.reply(`Email #${args[1]} not found.`); return; }
      await markUnread(gmailClient, found.messageId);
      await message.reply(`Marked #${id} as unread.`);
      return;
    }

    // ── !emaildigest unsubscribe [all | <id>] ────────────────────────────────
    if (sub === 'unsubscribe') {
      const gmailClient = await getGmailClient(userId);
      if (!gmailClient) {
        await message.reply("Not connected to Gmail. Run `!connect` first.");
        return;
      }
      const session = getDigestSession(userId);
      if (!session) { await message.reply("No active digest session. Run `!emaildigest` first."); return; }

      const target = args[1]?.toLowerCase();
      let toUnsub = [];

      if (target === 'all') {
        toUnsub = session.unsubscribeCandidates || [];
      } else {
        const id = parseInt(target, 10);
        const found = session.emails.find(e => e.shortId === id);
        if (!found) { await message.reply(`Email #${target} not found.`); return; }
        toUnsub = [found];
      }

      if (!toUnsub.length) { await message.reply("No unsubscribe candidates in your last digest."); return; }

      await message.reply(`Unsubscribing from ${toUnsub.length} sender(s)…`);

      let ok = 0, failed = 0, noHeader = 0;
      for (const e of toUnsub) {
        if (!e.messageId) { noHeader++; continue; }
        const result = await unsubscribe(gmailClient, e.messageId).catch(err => ({ method: 'none', success: false, detail: err.message }));
        if (result.method === 'none') noHeader++;
        else if (result.success) ok++;
        else failed++;
      }

      const parts = [];
      if (ok) parts.push(`✅ ${ok} unsubscribed`);
      if (failed) parts.push(`❌ ${failed} failed`);
      if (noHeader) parts.push(`⚠️ ${noHeader} had no unsubscribe link`);
      await message.reply(parts.join(', ') + '.');
      return;
    }

    // ── !emaildigest (run now) ────────────────────────────────────────────────
    await ctx._styping(message);
    const typingInterval = setInterval(() => ctx._styping(message).catch(() => {}), 8000);
    try {
      const text = await generateEmailDigest(userId, 24);
      await ctx.sendLongMessage(message, text, state.cwd);
    } catch (err) {
      await message.reply(`Email digest failed: ${err.message.slice(0, 300)}`).catch(() => {});
      ctx.sendErrorAlert(err, { source: 'emaildigest command', channel: message.channel.id });
    } finally {
      clearInterval(typingInterval);
    }
  }
};
