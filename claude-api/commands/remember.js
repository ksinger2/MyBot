module.exports = {
  name: '!remember',
  aliases: [],
  adminOnly: false,
  description: 'Explicitly store a preference or fact',
  async run(message, arg, state, ctx) {
    const phone = message._signalSenderId || null;
    if (!phone) {
      await message.reply('Profiles are Signal-only.');
      return;
    }

    const { addPreference, getProfile } = require('../user-profiles');

    if (!arg || !arg.trim()) {
      await message.reply('Usage: `!remember I\'m allergic to peanuts`');
      return;
    }

    const profile = getProfile(phone);
    if (!profile) {
      await message.reply('No profile found — send me a message on Signal to set up first.');
      return;
    }

    addPreference(phone, arg.trim(), 'explicit');
    await message.reply(`Remembered: ${arg.trim()}`);
  }
};
