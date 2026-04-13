/**
 * alerts.js — !alerts
 *
 * Lists all active price alert jobs for the current user.
 * Price alerts are schedules with a description starting with "Price Alert:".
 */

module.exports = {
  name: '!alerts',
  aliases: [],
  adminOnly: false,
  description: 'List your active concert price alerts',
  async run(message, arg, state, ctx) {
    const isGroup = message._signalChatId && message._signalChatId !== message._signalSenderId;
    if (isGroup) {
      await message.reply('Price alerts are personal — DM me to view yours.');
      return;
    }

    const allSchedules = ctx.getUserSchedules(message.author.id);
    const alerts = allSchedules.filter(s => s.description && s.description.startsWith('Price Alert:'));

    if (alerts.length === 0) {
      await message.reply(
        'You have no active price alerts.\n' +
        'Use `!setalert <show> $<price>` to create one — e.g. `!setalert Chappell Roan $75`'
      );
      return;
    }

    const lines = ['**Your Price Alerts:**', ''];
    alerts.forEach((sched, i) => {
      // Parse show name and threshold from description "Price Alert: Show Name (below $75)"
      const descMatch = sched.description.match(/^Price Alert:\s+(.+?)\s+\(below \$(.+?)\)$/);
      const showName = descMatch ? descMatch[1] : sched.description.replace('Price Alert:', '').trim();
      const threshold = descMatch ? `$${descMatch[2]}` : 'unknown';

      const created = sched.createdAt
        ? new Date(sched.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' })
        : 'unknown';

      lines.push(`**${i + 1}.** #${sched.id} — ${showName}`);
      lines.push(`   Target: ${threshold} · Schedule: \`${sched.cronRule}\` · Created: ${created}`);
    });

    lines.push('');
    lines.push('Use `!removealert <# or show name>` to cancel an alert.');

    await message.reply(lines.join('\n'));
  },
};
