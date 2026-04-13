module.exports = {
  name: '!kill',
  aliases: [],
  adminOnly: false,
  description: 'Hard kill + destroy session',
  async run(message, arg, state, ctx) {
    if (state.process) {
      await ctx.forceKillProcess(state.process);
      state.process = null;
      state.busy = false;
      state.startedAt = null;
      state.progress = ctx.freshProgress();
    }
    state.loopActive = false;
    state.sessionId = null;
    state.queue = [];
    if (state.groupingTimer) {
      clearTimeout(state.groupingTimer);
      state.groupingTimer = null;
      state.groupingBuffer = [];
      state.groupingSenderId = null;
    }
    state.activeTask = null;
    ctx.saveChannelState(message.channel.id, state, { critical: true });
    await message.reply('Process killed and session destroyed. Full reset — starting from scratch.');
  }
};
