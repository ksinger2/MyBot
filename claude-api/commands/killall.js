module.exports = {
  name: '!killall',
  aliases: [],
  adminOnly: true,
  description: 'Kill everything across all channels',
  async run(message, arg, state, ctx) {
    const killAllPromises = [];
    for (const [chId, s] of ctx.channels) {
      if (s.process) killAllPromises.push(ctx.forceKillProcess(s.process));
      s.process = null;
      s.busy = false;
      s.queue = [];
      s.sessionId = null;
      s.activeTask = null;
      ctx.saveChannelState(chId, s);
    }
    await Promise.all(killAllPromises);
    ctx.flushPendingWrites();
    ctx.channels.clear();
    await message.reply('All processes killed and all sessions destroyed across every channel.');
  }
};
