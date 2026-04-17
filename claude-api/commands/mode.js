module.exports = {
  name: '!mode',
  aliases: [],
  adminOnly: false,
  description: 'Toggle coding mode: `!mode plan` (research + propose, no edits) or `!mode auto` (execute freely). `!mode` shows current.',
  async run(message, arg, state, ctx) {
    const current = state.codingMode || 'auto';
    const want = (arg || '').trim().toLowerCase();

    if (!want) {
      await message.reply(`Current mode: **${current}**. Use \`!mode plan\` or \`!mode auto\` to switch.`);
      return;
    }

    if (want !== 'plan' && want !== 'auto') {
      await message.reply('Usage: `!mode plan` or `!mode auto`.');
      return;
    }

    if (current === want) {
      await message.reply(`Already in **${want}** mode.`);
      return;
    }

    state.codingMode = want;
    ctx.saveChannelState(message.channel.id, state, { critical: true });

    if (want === 'plan') {
      await message.reply('🧭 Plan mode active. I will research and propose — no file edits, no bash, no destructive commands. Send `!mode auto` when you want me to execute.');
    } else {
      await message.reply('⚡ Auto mode active. I will execute without waiting for plan approval.');
    }
  }
};
