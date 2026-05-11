module.exports = {
  name: '/reinit',
  aliases: ['!reinit'],
  adminOnly: false,
  description: 'Re-read project context with domain agents and suggest next steps',
  async run(message, arg, state, ctx) {
    if (state.busy) {
      await message.reply('Claude is still working. Use `!stop` first.');
      return;
    }

    state.sessionId = null;
    const reinitPrompt = ctx.buildReinitPrompt(state.cwd);
    await message.reply(`Re-initializing project context for \`${state.cwd}\` and gathering domain-agent recommendations...`);

    const personalityFile = ctx.getPersonalityFile(state.personality);
    await ctx._styping(message);
    const typingInterval = setInterval(() => { ctx._styping(message).catch(() => {}); }, 8000);

    try {
      const result = await ctx.runClaudeWithContinuation(reinitPrompt, {
        personalityFile,
        identity: state.identity,
        cwd: state.cwd,
        channelState: state,
      }, null);
      if (result.sessionId) {
        state.sessionId = result.sessionId;
        ctx.saveChannelState(message.channel.id, state);
      }
      if (!result.stopped) await ctx.sendLongMessage(message, result.text, state.cwd);
    } catch (err) {
      const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
      await message.reply(`Re-init error: ${errorMsg}`).catch(() => {});
      ctx.sendErrorAlert(err, { source: 'reinit command', channel: message.channel.id });
    } finally {
      clearInterval(typingInterval);
    }
  }
};
