module.exports = {
  name: '!audit',
  aliases: [],
  adminOnly: false,
  description: 'Full project audit (design, qa, security, analytics, performance)',
  async run(message, arg, state, ctx) {
    if (state.busy) {
      await message.reply('Claude is still working. Use `!stop` first.');
      return;
    }
    const validFocuses = ['full', 'design', 'qa', 'security', 'analytics', 'performance', 'product'];
    const auditFocus = arg ? arg.toLowerCase() : 'full';
    if (!validFocuses.includes(auditFocus)) {
      await message.reply(`Unknown focus: "${arg}". Options: ${validFocuses.join(', ')}`);
      return;
    }
    state.sessionId = null; // audit starts fresh
    const auditPrompt = ctx.buildAuditPrompt(auditFocus, state.cwd);
    const auditLabel = auditFocus === 'full' ? 'full audit' : `${auditFocus} audit`;
    await message.reply(`Starting **${auditLabel}** of \`${state.cwd}\`...`);
    const auditPersonalityFile = ctx.getPersonalityFile(state.personality);
    await message.channel.sendTyping();
    const auditTypingInterval = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
    try {
      const auditResult = await ctx.runClaudeWithContinuation(auditPrompt, {
        personalityFile: auditPersonalityFile,
        identity: state.identity,
        cwd: state.cwd,
        channelState: state,
        discordChannel: message.channel,
      }, ctx.ChannelProxy.fromDiscord(message.channel));
      if (auditResult.sessionId) {
        state.sessionId = auditResult.sessionId;
        ctx.saveChannelState(message.channel.id, state);
      }
      if (!auditResult.stopped) await ctx.sendLongMessage(message, auditResult.text, state.cwd);
    } catch (err) {
      const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
      await message.reply(`Audit error: ${errorMsg}`).catch(() => {});
      ctx.sendErrorAlert(err, { source: 'audit command', channel: message.channel.id });
    } finally {
      clearInterval(auditTypingInterval);
    }
  }
};
