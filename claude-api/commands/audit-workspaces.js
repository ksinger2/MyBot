const { startAudit, stopAudit, getAuditStatus } = require('../workspace-audit');

module.exports = {
  name: '!audit',
  aliases: [],
  adminOnly: true,
  description: 'Start/stop periodic workspace audits (!audit <minutes> | !audit off | !audit status)',
  async run(message, arg, state, ctx) {
    if (!arg || arg === 'status') {
      const status = getAuditStatus();
      if (status.active) {
        const lastRun = status.lastRun ? `${Math.round((Date.now() - status.lastRun) / 60000)}min ago` : 'never';
        await message.reply(`Workspace audit **active** — every ${status.intervalMinutes}min. Last run: ${lastRun}. ${status.inFlight ? '⏳ Currently running.' : ''}`);
      } else {
        await message.reply('No workspace audit active. Use `!audit <minutes>` to start (e.g. `!audit 60`).');
      }
      return;
    }
    if (arg === 'off' || arg === 'stop') {
      stopAudit();
      await message.reply('Workspace audit stopped.');
      return;
    }
    if (arg === 'now') {
      // Trigger immediate audit by starting with 1-min interval then stopping after first run
      const reply = ctx._dreply || ((m, t) => m.reply(t));
      await reply(message, '🔍 Running workspace audit now...');
      // Fall through to start with short interval — the timer fires at next minute boundary
    }
    const interval = arg === 'now' ? 60 : parseInt(arg, 10);
    if (isNaN(interval) || interval < 5) {
      await message.reply('Usage: `!audit <minutes>` (min 5) | `!audit off` | `!audit status` | `!audit now`');
      return;
    }
    const personalityFile = ctx.getPersonalityFile(state.personality);
    const signalAdapter = ctx.signalAdapter;
    const chatId = message._signalChatId || message.chatId || message.channel?.id;

    startAudit({
      intervalMinutes: interval,
      askClaude: ctx.askClaude,
      getPersonalityFile: ctx.getPersonalityFile,
      ownerState: state,
      sendReport: async (text) => {
        if (signalAdapter && chatId) {
          await signalAdapter.sendLongMessage(chatId, text);
        } else if (message.channel) {
          await ctx.sendLongMessage(message, text, state.cwd);
        }
      },
    });
    await message.reply(`Workspace audit started — checking all sandbox projects every **${interval} minutes**. Use \`!audit off\` to stop.`);
  }
};
