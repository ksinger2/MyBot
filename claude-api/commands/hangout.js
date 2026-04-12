module.exports = {
  name: '!hangout',
  aliases: [],
  adminOnly: false,
  description: 'Start the hangout planning wizard',
  async run(message, arg, state, ctx) {
    ctx.startHangoutWizard(state, message);
  }
};
