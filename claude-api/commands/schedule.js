module.exports = {
  name: '!schedule',
  aliases: [],
  adminOnly: false,
  description: 'Create a new scheduled message',
  async run(message, arg, state, ctx) {
    if (state.busy) {
      await message.reply('Claude is still working. Use `!stop` first.');
      return;
    }
    if (state.wizard) {
      await message.reply('A wizard is already active. Use `!cancel` to cancel it first.');
      return;
    }
    await ctx.startWizard(state, message, {
      type: 'schedule',
      steps: [
        {
          key: 'message',
          prompt: 'What message should I send you? (e.g. "Time to check your stocks!" or "Drink water and stretch")',
        },
        {
          key: 'frequency',
          prompt: 'How often? Pick one:\n' +
            '• `daily at 9am` — every day at a specific time\n' +
            '• `every 2 hours` — repeating interval\n' +
            '• `weekdays at 8:30am` — Mon-Fri only\n' +
            '• `monday at 10am` — specific day of week\n' +
            '• Or a cron expression like `0 */3 * * *`',
          validate: (input) => {
            const parsed = ctx.parseFrequency(input);
            if (!parsed) return 'Could not understand that frequency. Try something like `daily at 9am`, `every 3 hours`, `weekdays at 8:30am`, or a cron expression.';
            return true;
          },
        },
      ],
      onComplete: async (data, msg) => {
        const parsed = ctx.parseFrequency(data.frequency);
        const sched = ctx.addSchedule({
          userId: msg.author.id,
          channelId: msg.channel.id,
          message: data.message,
          cronRule: parsed.cron,
          description: parsed.description,
          timezone: 'America/Los_Angeles',
        });
        ctx.registerJob(sched, ctx.client);
        await msg.reply(
          `Scheduled! **#${sched.id}**\n` +
          `📝 "${sched.message}"\n` +
          `⏰ ${parsed.description}\n` +
          `I'll DM you each time. Use \`!schedules\` to see all, \`!unschedule ${sched.id}\` to remove.`
        );
      },
    });
  }
};
