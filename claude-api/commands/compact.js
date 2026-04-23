module.exports = {
  name: '!compact',
  aliases: [],
  adminOnly: false,
  description: 'Compact conversation context — starts fresh session but keeps recent context',
  async run(message, arg, state, ctx) {
    if (!state.sessionId) {
      await message.reply('No active session to compact. Start a conversation first.');
      return;
    }
    if (state.busy) {
      await message.reply("Can't compact while I'm working — wait until I finish.");
      return;
    }

    state.sessionId = null;
    state.sessionStartedAt = null;
    state.sessionTurns = 0;
    state.sessionCost = 0;
    // recentMessages are preserved — they'll be injected into the next session's
    // system prompt, giving continuity without the full conversation history.
    ctx.saveChannelState(message.channel.id, state, { critical: true });
    await message.reply('Context compacted — session reset but I remember our recent messages. Next message continues with a lighter context window.');
  }
};
