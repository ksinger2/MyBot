const googleAuth = require('../google-auth');
const userTokens = require('../user-tokens');

module.exports = {
  name: '!botcalendar',
  aliases: ['!botcal'],
  adminOnly: true,
  description: 'Manage the bot\'s own Google Calendar account for centralized event scheduling',
  async run(message, arg, state, ctx) {
    const sub = (arg || '').trim().toLowerCase();

    if (sub === 'connect') {
      if (!process.env.GOOGLE_CLIENT_ID) {
        await message.reply('Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI env vars.');
        return;
      }
      const authUrl = googleAuth.getAuthUrl(googleAuth.BOT_CALENDAR_KEY);
      await message.reply(
        `Connect the bot's own Google Calendar account:\n${authUrl}\n\n` +
        `Log into the bot's Gmail (e.g. bianca.she.da.cow@gmail.com) and authorize. ` +
        `Once connected, the bot creates events as the organizer and invites users directly.`
      );
      return;
    }

    if (sub === 'disconnect') {
      const removed = userTokens.removeToken(googleAuth.BOT_CALENDAR_KEY);
      await message.reply(removed ? 'Bot calendar account disconnected.' : 'Bot calendar was not connected.');
      return;
    }

    if (sub === 'status' || !sub) {
      const email = googleAuth.getBotCalendarEmail();
      if (email) {
        await message.reply(`Bot calendar connected: ${email}\nEvents are created on the bot's calendar and users are invited as attendees.`);
      } else {
        await message.reply('Bot calendar not connected. Run !botcalendar connect to link the bot\'s own Google account.');
      }
      return;
    }

    await message.reply('Usage: !botcalendar [connect|disconnect|status]');
  }
};
