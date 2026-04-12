module.exports = {
  name: '!email',
  aliases: [],
  adminOnly: false,
  description: 'Draft email options via Claude',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply('Usage: `!email <who and what>` — e.g. `!email my manager about needing Friday off`');
      return;
    }
    const emailPrompt = `Draft 3 email options for the following request. Each option should be a different tone/approach (e.g. direct, warm, formal). For each option:\n- Subject line\n- Body\n\nKeep them professional, clear, and concise. No fluff.\n\nRequest: ${arg}`;
    const emailState = ctx.getChannel(message.channel.id);
    if (emailState.busy) {
      await message.reply('Claude is still working. Use `!stop` first.');
      return;
    }
    const personalityFile = ctx.getPersonalityFile(emailState.personality);
    await message.channel.sendTyping();
    const typingInterval = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
    try {
      const result = await ctx.askClaude(emailPrompt, {
        sessionId: emailState.sessionId,
        personalityFile,
        identity: emailState.identity,
        cwd: emailState.cwd,
        channelState: emailState,
        discordChannel: message.channel,
      });
      if (result.sessionId) emailState.sessionId = result.sessionId;
      if (!result.stopped) await ctx.sendLongMessage(message, result.text, emailState.cwd);
    } catch (err) {
      const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
      await message.reply(`Error: ${errorMsg}`).catch(() => {});
      ctx.sendErrorAlert(err, { source: 'email command', channel: message.channel.id });
    } finally {
      clearInterval(typingInterval);
    }
  }
};
