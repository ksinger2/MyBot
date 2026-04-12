module.exports = {
  name: '!weekly',
  aliases: [],
  adminOnly: false,
  description: 'Run weekly preview',
  async run(message, arg, state, ctx) {
    const briefings = require('../briefings');
    await message.reply('Running weekly preview now...');
    briefings.sendWeeklyPreview(ctx.client).catch(err => {
      message.reply(`Weekly preview failed: ${err.message}`).catch(() => {});
    });
  }
};
