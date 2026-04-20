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
    state.queue = [];
    state.activeTask = null;
    // Also wipe the Haiku SDK fast-path history for this channel so
    // non-owner DMs truly start fresh (the CLI session resume isn't
    // the only memory path anymore).
    try {
      const { clearHistory } = require('../chat-responder');
      clearHistory(message.channel.id);
    } catch {}
    ctx.saveChannelState(message.channel.id, state, { critical: true });
    await message.reply('Context cleared. Next message starts a fresh conversation (no memory of previous messages).');
  }
};
