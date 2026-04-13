/**
 * removealert.js — !removealert [number or show name]
 *
 * Removes a price alert job by index from !alerts list or by matching show name.
 */

module.exports = {
  name: '!removealert',
  aliases: [],
  adminOnly: false,
  description: 'Remove a concert price alert',
  async run(message, arg, state, ctx) {
    const isGroup = message._signalChatId && message._signalChatId !== message._signalSenderId;
    if (isGroup) {
      await message.reply('Price alerts are personal — DM me to manage yours.');
      return;
    }

    if (!arg) {
      await message.reply(
        'Usage: `!removealert <# or show name>`\n' +
        'Use `!alerts` to see your list, then remove by number or show name.\n' +
        'Examples:\n' +
        '  `!removealert 1`\n' +
        '  `!removealert Chappell Roan`'
      );
      return;
    }

    const query = arg.trim();
    const allSchedules = ctx.getUserSchedules(message.author.id);
    const alerts = allSchedules.filter(s => s.description && s.description.startsWith('Price Alert:'));

    if (alerts.length === 0) {
      await message.reply('You have no active price alerts. Use `!setalert <show> $<price>` to create one.');
      return;
    }

    let targetSched = null;

    // Try by !alerts list index (1-based)
    const listNum = parseInt(query, 10);
    if (!isNaN(listNum) && listNum >= 1 && listNum <= alerts.length) {
      targetSched = alerts[listNum - 1];
    }

    // Try by schedule ID (direct)
    if (!targetSched) {
      const schedId = parseInt(query, 10);
      if (!isNaN(schedId)) {
        targetSched = alerts.find(s => s.id === schedId);
      }
    }

    // Try by show name (case-insensitive substring match against description)
    if (!targetSched) {
      const queryLower = query.toLowerCase();
      targetSched = alerts.find(s => {
        const descLower = s.description.toLowerCase();
        // Match against "Price Alert: <show> (below $X)" — strip prefix for cleaner match
        const showPart = descLower.replace(/^price alert:\s*/, '').replace(/\s*\(below \$[\d.]+\)\s*$/, '');
        return showPart.includes(queryLower) || descLower.includes(queryLower);
      });
    }

    if (!targetSched) {
      await message.reply(
        `No price alert matching "${query}" found.\n` +
        'Use `!alerts` to see your list with numbers.'
      );
      return;
    }

    const removed = ctx.removeSchedule(targetSched.id, message.author.id);
    if (!removed) {
      await message.reply(`Could not remove alert #${targetSched.id}. It may have already been deleted.`);
      return;
    }

    ctx.cancelJob(targetSched.id);

    // Extract show name for a friendly message
    const descMatch = removed.description.match(/^Price Alert:\s+(.+?)\s+\(below \$(.+?)\)$/);
    const showName = descMatch ? descMatch[1] : removed.description.replace('Price Alert:', '').trim();

    await message.reply(`Removed price alert for **${showName}** (was #${removed.id}).`);
  },
};
