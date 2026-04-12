module.exports = {
  name: '!setup',
  aliases: [],
  adminOnly: false,
  description: 'Generate a setup link for profile configuration',
  async run(message, arg, state, ctx) {
    const senderId = message.author?.id || message._signalSenderId;
    const { isSignalOwner: _iso4 } = require('../project-permissions');
    const targetPhone = (arg.trim() && _iso4(senderId)) ? arg.trim() : senderId;
    const baseUrl = process.env.PUBLIC_URL || `http://localhost:3400`;
    const setupUrl = `${baseUrl}/setup/${encodeURIComponent(targetPhone)}`;
    await message.reply(`Setup link for ${targetPhone}:\n${setupUrl}\n\nTap it on your phone to set your name, location, and connect Google Calendar.`);
  }
};
