module.exports = {
  name: '!autoschedule',
  aliases: [],
  adminOnly: true,
  description: 'Schedule an autonomous task on a recurring basis',
  async run(message, arg, state, ctx) {
    if (!arg || !arg.includes('|')) {
      await message.reply('Usage: `!autoschedule <frequency> | <task>`\nExample: `!autoschedule daily at 9am | check all projects for failing tests and fix them`');
      return;
    }
    const [freqPart, ...taskParts] = arg.split('|');
    const freq = freqPart.trim();
    const task = taskParts.join('|').trim();
    if (!freq || !task) {
      await message.reply('Both frequency and task required. Example: `!autoschedule every 2 hours | run the test suite`');
      return;
    }
    const parsed = ctx.parseFrequency(freq);
    if (!parsed) {
      await message.reply(`Couldn't parse frequency: "${freq}". Try: daily at 9am, every 2 hours, weekdays at 8:30am`);
      return;
    }
    const autoSched = ctx.addSchedule({
      userId: message.author.id,
      channelId: message.channel.id,
      message: task,
      cronRule: parsed.cron,
      description: parsed.description,
      type: 'task',
      cwd: state.cwd,
      timezone: 'America/Los_Angeles',
    });
    ctx.registerJob(autoSched, ctx.client);
    await message.reply(
      `Autonomous task scheduled! **#${autoSched.id}**\n` +
      `⏰ ${parsed.description}\n` +
      `📋 "${task.substring(0, 100)}"\n` +
      `📁 \`${state.cwd}\`\n` +
      `I'll execute this autonomously each time. Use \`!schedules\` to see all, \`!unschedule ${autoSched.id}\` to remove.`
    );
  }
};
