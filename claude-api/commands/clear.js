module.exports = {
  name: '!clear',
  aliases: [],
  adminOnly: false,
  description: 'Clear conversation context',
  async run(message, arg, state, ctx) {
    if (state.process) {
      state._userStopped = true;
      await ctx.forceKillProcess(state.process);
      state.process = null;
      state.busy = false;
      state.startedAt = null;
      state.progress = ctx.freshProgress();
    }
    state.loopActive = false;
    state.sessionId = null;
    state.sessionStartedAt = null;
    state.sessionTurns = 0;
    state.sessionCost = 0;
    state.queue = [];
    state.activeTask = null;
    ctx.saveChannelState(message.channel.id, state, { critical: true });
    await message.reply('Context cleared. Next message starts a fresh conversation (no memory of previous messages).');
  }
};
