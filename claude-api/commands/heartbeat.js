module.exports = {
  name: '!heartbeat',
  aliases: [],
  adminOnly: false,
  description: 'Start/stop/check periodic heartbeat',
  async run(message, arg, state, ctx) {
    if (!arg || arg === 'status') {
      const hb = ctx.getHeartbeatStatus(message.channel.id);
      if (hb) {
        await message.reply(`Heartbeat **active** — every ${hb.intervalMinutes}min in \`${hb.cwd}\``);
      } else {
        await message.reply('No heartbeat active. Use `!heartbeat <minutes>` to start (e.g. `!heartbeat 30`).');
      }
      return;
    }
    if (arg === 'off' || arg === 'stop') {
      ctx.stopHeartbeat(message.channel.id);
      await message.reply('Heartbeat stopped.');
      return;
    }
    const interval = parseInt(arg, 10);
    if (isNaN(interval) || interval < 5) {
      await message.reply('Usage: `!heartbeat <minutes>` (min 5) | `!heartbeat off` | `!heartbeat status`');
      return;
    }
    const personalityFile = ctx.getPersonalityFile(state.personality);
    ctx.startHeartbeat(message.channel.id, {
      cwd: state.cwd,
      intervalMinutes: interval,
      onWake: (prompt) => ctx.askClaude(prompt, {
        sessionId: state.sessionId,
        personalityFile,
        identity: state.identity,
        cwd: state.cwd,
        channelState: state,
        discordChannel: message.channel,
      }),
      onResult: async (result) => {
        if (result.sessionId) { state.sessionId = result.sessionId; ctx.saveChannelState(message.channel.id, state); }
        await ctx.sendLongMessage(message, result.text, state.cwd);
      },
    });
    await message.reply(`Heartbeat started — checking every **${interval} minutes**. Reads AGENTS.md for standing orders. Use \`!heartbeat off\` to stop.`);
  }
};
