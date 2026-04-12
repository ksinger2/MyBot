module.exports = {
  name: '!briefing',
  aliases: [],
  adminOnly: false,
  description: 'Run daily briefing',
  async run(message, arg, state, ctx) {
    const briefings = require('../briefings');
    await message.reply('Running briefing now...');
    briefings.sendBriefing(ctx.client).catch(err => {
      message.reply(`Briefing failed: ${err.message}`).catch(() => {});
    });
  }
};
