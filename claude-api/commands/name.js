module.exports = {
  name: '!name',
  aliases: [],
  adminOnly: true,
  description: 'Show or set bot name',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply(`My name is **${state.identity.name}**`);
    } else {
      const newName = arg.trim().substring(0, 50);
      state.identity.name = newName;
      state.sessionId = null;
      ctx.saveChannelState(message.channel.id, state);
      await message.reply(`Name changed to **${state.identity.name}**! Session cleared.`);
    }
  }
};
