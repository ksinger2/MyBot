module.exports = {
  name: '!unschedule',
  aliases: [],
  adminOnly: false,
  description: 'Remove a scheduled message',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply('Usage: `!unschedule <#>` — e.g. `!unschedule 1`');
      return;
    }
    const id = parseInt(arg, 10);
    if (isNaN(id)) {
      await message.reply('Usage: `!unschedule <#>` — provide the schedule number.');
      return;
    }
    const removed = ctx.removeSchedule(id, message.author.id);
    if (!removed) {
      await message.reply(`No schedule #${id} found for you. Use \`!schedules\` to see your list.`);
    } else {
      ctx.cancelJob(id);
      await message.reply(`Removed schedule **#${id}**: "${removed.description}"`);
    }
  }
};
