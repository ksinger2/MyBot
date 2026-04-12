module.exports = {
  name: '!ainews',
  aliases: [],
  adminOnly: false,
  description: 'Scan AI news',
  async run(message, arg, state, ctx) {
    const aiNews = require('../ai-news');
    await message.reply('Scanning AI news now...');
    aiNews.sendAINews(ctx.client).catch(err => {
      message.reply(`AI news failed: ${err.message}`).catch(() => {});
    });
  }
};
