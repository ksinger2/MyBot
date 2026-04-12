module.exports = {
  name: '!personalities',
  aliases: [],
  adminOnly: false,
  description: 'List available personalities',
  async run(message, arg, state, ctx) {
    const available = ctx.listPersonalities();
    const list = available.map(p => p === state.personality ? `**${p}** (active)` : p).join('\n- ');
    await message.reply(`Available personalities:\n- ${list}`);
  }
};
