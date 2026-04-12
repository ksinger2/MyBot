module.exports = {
  name: '!identity',
  aliases: [],
  adminOnly: true,
  description: 'Show or set identity',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply(`**${state.identity.name}** — ${state.identity.description}`);
    } else {
      if (arg.length > 300) {
        await message.reply('Identity description too long (max 300 chars).');
        return;
      }
      const isMatch = arg.match(/^(\S+)\s+is\s+(.+)$/i);
      if (isMatch) {
        state.identity.name = isMatch[1].substring(0, 50);
        state.identity.description = isMatch[2].trim().substring(0, 250);
      } else {
        state.identity.description = arg.trim().substring(0, 250);
      }
      state.sessionId = null;
      ctx.saveChannelState(message.channel.id, state);
      await message.reply(`Identity updated: **${state.identity.name}** — ${state.identity.description}\nSession cleared.`);
    }
  }
};
