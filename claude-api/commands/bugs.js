module.exports = {
  name: '!bugs',
  aliases: [],
  adminOnly: false,
  description: 'Automated bug discovery and fix orchestration',
  async run(message, arg, state, ctx) {
    const bugSkill = ctx.getSkill('bug-list');
    if (!bugSkill) {
      await message.reply('Bug list skill not found. Make sure `skills/core/bug-list.md` exists.');
      return;
    }
    if (state.busy) {
      await message.reply('Already working on something. Use `!stop` first.');
      return;
    }

    state.busy = true;
    state.startedAt = Date.now();
    state.progress = ctx.freshProgress();
    await ctx._styping(message);
    const bugTypingInterval = setInterval(() => { ctx._styping(message).catch(() => {}); }, 8000);

    const bugPrompt = `${bugSkill.instructions}\n\n${arg ? `Initial context/bugs to address:\n${arg}` : 'Ready to receive bugs. List them one by one and I will orchestrate agents to fix them.'}`;
    const personalityFile = ctx.getPersonalityFile(state.personality);

    try {
      const result = await ctx.askClaude(bugPrompt, {
        sessionId: state.sessionId,
        personalityFile,
        identity: state.identity,
        cwd: state.cwd,
        maxTurns: 100,
        channelState: state,
      });

      if (result.sessionId) state.sessionId = result.sessionId;
      if (!result.stopped) {
        await ctx.sendLongMessage(message, result.text, state.cwd);
      }
    } catch (err) {
      const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
      await message.reply(`Bug orchestrator error: ${errorMsg}`).catch(() => {});
      ctx.sendErrorAlert(err, { source: 'bugs command', channel: message.channel.id });
    } finally {
      clearInterval(bugTypingInterval);
      state.busy = false;
      state.startedAt = null;
      state.progress = ctx.freshProgress();
    }
  }
};
