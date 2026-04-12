module.exports = {
  name: '!stop',
  aliases: [],
  adminOnly: false,
  description: 'Stop the current Claude process',
  async run(message, arg, state, ctx) {
    const wasLooping = state.loopActive;
    if (state.process) {
      state._userStopped = true;
      await ctx.forceKillProcess(state.process);
      state.process = null;
      state.busy = false;
      state.loopActive = false;
      state.startedAt = null;
      state.progress = ctx.freshProgress();
      const dropped = state.queue.length;
      state.queue = [];
      const extra = dropped ? ` (${dropped} queued message${dropped > 1 ? 's' : ''} cleared)` : '';
      await message.reply(`Stopped${wasLooping ? ' loop' : ''}. Session preserved — send another message to continue.${extra}`);
    } else if (state.busy || state.loopActive) {
      state.busy = false;
      state.loopActive = false;
      state.startedAt = null;
      state.progress = ctx.freshProgress();
      const dropped = state.queue.length;
      state.queue = [];
      ctx.saveChannelState(message.channel.id, state, { critical: true });
      const extra = dropped ? ` (${dropped} queued message${dropped > 1 ? 's' : ''} cleared)` : '';
      await message.reply(`Cleared stuck state${wasLooping ? ' (loop ended)' : ''}.${extra} You're good to go.`);
    } else {
      await message.reply('Nothing is running in this channel.');
    }
  }
};
