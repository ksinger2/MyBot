module.exports = {
  name: '!cancel',
  aliases: [],
  adminOnly: false,
  description: 'Cancel an active wizard',
  async run(message, arg, state, ctx) {
    await ctx.cancelWizard(state, message);
  }
};
