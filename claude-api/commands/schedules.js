module.exports = {
  name: '!schedules',
  aliases: [],
  adminOnly: false,
  description: 'List your scheduled messages',
  async run(message, arg, state, ctx) {
    const isGroup = message._signalChatId && message._signalChatId !== message._signalSenderId;
    if (isGroup) { await message.reply('Schedules are private — DM me to view yours.'); return; }
    const userSchedules = ctx.getUserSchedules(message.author.id);
    if (userSchedules.length === 0) {
      await message.reply('You have no scheduled messages. Use `!schedule` to create one.');
    } else {
      await message.reply(`**Your Schedules:**\n${ctx.formatScheduleList(userSchedules)}\n\nUse \`!unschedule <#>\` to remove one.`);
    }
  }
};
