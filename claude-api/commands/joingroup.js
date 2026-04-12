module.exports = {
  name: '!joingroup',
  aliases: [],
  adminOnly: true,
  description: 'Join a Signal group via invite link',
  async run(message, arg, state, ctx) {
    if (!ctx.signalAdapter) {
      await message.reply('Signal adapter not running.');
      return;
    }
    if (!arg) {
      await message.reply('Usage: `!joingroup <signal-group-invite-link>`\nGet the link from Signal: open the group → tap the name → Group Link → enable + copy.\nExample: `!joingroup https://signal.group/#CjQK...`');
      return;
    }
    const uri = arg.trim();
    if (!/^https?:\/\/signal\.group\/#/.test(uri)) {
      await message.reply('That doesn\'t look like a Signal group link. It should start with `https://signal.group/#`');
      return;
    }
    await message.reply('Trying to join the group via invite link...');
    try {
      const result = await ctx.signalAdapter.joinGroupByLink(uri);
      await ctx.signalAdapter._loadGroups().catch(() => {});
      const groupId = result?.groupId || result?.group_id || '(unknown)';
      await message.reply(`✅ Joined! Internal group ID: \`${groupId}\`. You can now message me in that group.`);
    } catch (err) {
      await message.reply(`❌ Couldn't join: ${err.message.substring(0, 400)}`);
      ctx.sendErrorAlert(err, { source: '!joingroup', channel: message.channel.id, detail: uri.substring(0, 100) });
    }
  }
};
