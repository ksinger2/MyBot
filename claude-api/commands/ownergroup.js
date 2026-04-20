/**
 * !ownergroup — register/unregister a group chat as an owner group.
 *
 * Owner groups get full CLI access (Opus, no turn limit, no brevity, no
 * @mention requirement) — identical to messaging Bianca directly as owner.
 * Owner-only command.
 *
 * Usage (run inside a group chat):
 *   !ownergroup add    → register this group
 *   !ownergroup remove → unregister this group
 *   !ownergroup list   → show all registered owner groups
 *   !ownergroup        → show whether this group is registered
 */
const { isOwnerGroup, addOwnerGroup, removeOwnerGroup, listOwnerGroups } = require('../owner-groups');

module.exports = {
  name: '!ownergroup',
  aliases: ['!ownergroups'],
  ownerOnly: true,
  adminOnly: false,
  description: 'Register this group for full owner-mode CLI access (owner only)',
  async run(message, arg, state, ctx) {
    const { isSignalOwner } = require('../project-permissions');
    const senderId = message._signalSenderId || message.author?.id;

    if (!isSignalOwner(senderId)) {
      await message.reply('Owner only.');
      return;
    }

    const chatId = message.channel?.id || message._signalChatId || state?._channelId;
    const sub = (arg || '').trim().toLowerCase();

    if (sub === 'add') {
      addOwnerGroup(chatId);
      await message.reply('✅ This group is now an **owner group** — full CLI access, no @mention needed.');
      return;
    }

    if (sub === 'remove') {
      removeOwnerGroup(chatId);
      await message.reply('✅ This group is no longer an owner group. Back to standard group mode.');
      return;
    }

    if (sub === 'list') {
      const groups = listOwnerGroups();
      if (groups.length === 0) {
        await message.reply('No owner groups registered.');
      } else {
        await message.reply(`Owner groups (${groups.length}):\n${groups.join('\n')}`);
      }
      return;
    }

    // Default: show status of current group
    const registered = isOwnerGroup(chatId);
    await message.reply(
      registered
        ? `✅ This group IS an owner group. Use \`!ownergroup remove\` to downgrade.`
        : `❌ This group is NOT an owner group. Use \`!ownergroup add\` to register it.`
    );
  },
};
