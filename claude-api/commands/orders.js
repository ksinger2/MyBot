module.exports = {
  name: '!orders',
  aliases: [],
  adminOnly: false,
  description: 'View standing orders from AGENTS.md',
  async run(message, arg, state, ctx) {
    const orders = ctx.loadStandingOrders(state.cwd);
    if (!orders) {
      await message.reply(`No standing orders found. Create \`AGENTS.md\` in \`${state.cwd}\` with instructions for autonomous work.`);
    } else {
      await ctx.sendLongMessage(message, `**Standing Orders (AGENTS.md):**\n${orders}`, state.cwd);
    }
  }
};
