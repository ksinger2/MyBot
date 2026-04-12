module.exports = {
  name: '!trip',
  aliases: [],
  adminOnly: false,
  description: 'Start the trip planner wizard',
  async run(message, arg, state, ctx) {
    ctx.startTripPlannerWizard(state, message);
  }
};
