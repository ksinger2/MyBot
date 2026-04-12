const path = require('path');

module.exports = {
  name: '!permit',
  aliases: [],
  adminOnly: false, // Has its own owner check
  description: 'Grant a user access to the current project (Signal)',
  async run(message, arg, state, ctx) {
    const { isSignalOwner: _iso, grantPermission } = require('../project-permissions');
    const senderId = message.author?.id || message._signalSenderId;
    if (!_iso(senderId)) {
      await message.reply('Only the owner can grant permissions.');
      return;
    }
    const target = arg.trim();
    if (!target) { await message.reply('Usage: `!permit +1234567890`'); return; }
    grantPermission(target, state.cwd);
    await message.reply(`Granted ${target} access to ${path.basename(state.cwd) || state.cwd}.`);
  }
};
