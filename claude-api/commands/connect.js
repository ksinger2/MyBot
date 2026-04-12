module.exports = {
  name: '!connect',
  aliases: [],
  adminOnly: false,
  description: 'Connect Google Calendar',
  async run(message, arg, state, ctx) {
    try {
      const googleAuth = require('../google-auth');
      if (!process.env.GOOGLE_CLIENT_ID) {
        await message.reply('Google OAuth is not configured. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` env vars.');
        return;
      }
      const authUrl = googleAuth.getAuthUrl(message.author.id);
      try {
        await message.author.send(`Connect your Google Calendar to the bot:\n${authUrl}\n\nThis lets the bot check your availability for group planning.`);
        await message.reply('Sent you a DM with the Google authorization link!');
      } catch {
        await message.reply(`I couldn't DM you. Here's the link (authorize within 10 min):\n${authUrl}`);
      }
    } catch (err) {
      await message.reply(`Connect failed: ${err.message.substring(0, 200)}`);
    }
  }
};
