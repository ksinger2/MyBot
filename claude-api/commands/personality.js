module.exports = {
  name: '!personality',
  aliases: [],
  adminOnly: true,
  description: 'Show or switch personality',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply(`Current personality: **${state.personality}**`);
    } else {
      const file = ctx.getPersonalityFile(arg);
      if (!file) {
        const available = ctx.listPersonalities().join(', ');
        await message.reply(`Personality "${arg}" not found. Available: **${available}**`);
      } else {
        state.personality = arg;
        state.sessionId = null;
        ctx.saveChannelState(message.channel.id, state, { critical: true });
        await message.reply(`Personality switched to **${arg}**! Session cleared.`);
      }
    }
  }
};
