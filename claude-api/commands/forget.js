module.exports = {
  name: '!forget',
  aliases: [],
  adminOnly: false,
  description: 'Remove stored preferences by keyword, or all',
  async run(message, arg, state, ctx) {
    const phone = message._signalSenderId || null;
    if (!phone) {
      await message.reply('Profiles are Signal-only.');
      return;
    }

    const { removePreference, clearPreferences } = require('../user-profiles');

    if (!arg || !arg.trim()) {
      await message.reply('Usage: `!forget <keyword>` or `!forget all`');
      return;
    }

    if (arg.trim().toLowerCase() === 'all') {
      clearPreferences(phone);
      await message.reply('All preferences cleared. Your basic profile (name, location, timezone) is kept.');
      return;
    }

    const removed = removePreference(phone, arg.trim());
    if (removed > 0) {
      await message.reply(`Removed ${removed} preference(s) matching "${arg.trim()}".`);
    } else {
      await message.reply(`No preferences matching "${arg.trim()}" found.`);
    }
  }
};
