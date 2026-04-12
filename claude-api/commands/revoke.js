const path = require('path');

module.exports = {
  name: '!revoke',
  aliases: [],
  adminOnly: false, // Has its own owner check
  description: 'Revoke a user\'s access to the current project (Signal)',
  async run(message, arg, state, ctx) {
    const { isSignalOwner: _iso2, revokePermission } = require('../project-permissions');
    const senderId = message.author?.id || message._signalSenderId;
    if (!_iso2(senderId)) {
      await message.reply('Only the owner can revoke permissions.');
      return;
    }
    const target = arg.trim();
    if (!target) { await message.reply('Usage: `!revoke +1234567890`'); return; }
    revokePermission(target, state.cwd);
    await message.reply(`Revoked ${target}'s access to ${path.basename(state.cwd) || state.cwd}.`);
  }
};
