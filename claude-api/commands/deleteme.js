module.exports = {
  name: '!deleteme',
  aliases: [],
  adminOnly: false,
  description: 'Permanently delete all your stored data',
  async run(message, arg, state, ctx) {
    const phone = message._signalSenderId || null;
    if (!phone) {
      await message.reply('Profiles are Signal-only.');
      return;
    }

    const { deleteUser, getProfile } = require('../user-profiles');

    if (arg && arg.trim().toLowerCase() === 'confirm') {
      const existed = deleteUser(phone);
      if (existed) {
        await message.reply('All your data has been deleted. Your next message will start fresh onboarding.');
      } else {
        await message.reply('No profile found to delete.');
      }
      return;
    }

    // First call — warn before destructive action
    await message.reply('This will permanently delete ALL your data (profile, preferences, everything). Send `!deleteme confirm` to proceed.');
  }
};
