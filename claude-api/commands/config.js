module.exports = {
  name: '!config',
  aliases: [],
  adminOnly: true,
  description: 'View or set per-channel configuration',
  async run(message, arg, state, ctx) {
    const configParts = arg ? arg.trim().split(/\s+/) : [];
    const configKey = configParts[0];
    const configVal = configParts[1];

    if (!configKey || configKey === 'show') {
      const c = state.config || {};
      const lines = [
        `**Channel Config:**`,
        `Max turns: ${c.maxTurns || ctx.DEFAULT_MAX_TURNS} ${c.maxTurns ? '(custom)' : '(default)'}`,
        `Auto-continues: ${c.maxContinues || ctx.MAX_AUTO_CONTINUES} ${c.maxContinues ? '(custom)' : '(default)'}`,
        `Timeout: ${c.maxTimeout ? c.maxTimeout / 60000 : ctx.MAX_TIMEOUT / 60000}min ${c.maxTimeout ? '(custom)' : '(default)'}`,
        `Session cost cap: ${c.maxSessionCost ? `$${c.maxSessionCost}` : 'none'} ${c.maxSessionCost ? '(custom)' : '(default)'}`,
      ];
      await message.reply(lines.join('\n'));
    } else if (configKey === 'turns' && configVal) {
      state.config = state.config || {};
      state.config.maxTurns = parseInt(configVal, 10);
      ctx.saveChannelState(message.channel.id, state, { critical: true });
      await message.reply(`Max turns set to **${state.config.maxTurns}** for this channel.`);
    } else if (configKey === 'continues' && configVal) {
      state.config = state.config || {};
      state.config.maxContinues = parseInt(configVal, 10);
      ctx.saveChannelState(message.channel.id, state, { critical: true });
      await message.reply(`Auto-continues set to **${state.config.maxContinues}** for this channel.`);
    } else if (configKey === 'timeout' && configVal) {
      state.config = state.config || {};
      state.config.maxTimeout = parseInt(configVal, 10) * 60 * 1000;
      ctx.saveChannelState(message.channel.id, state, { critical: true });
      await message.reply(`Timeout set to **${configVal} minutes** for this channel.`);
    } else if (configKey === 'cost' && configVal) {
      state.config = state.config || {};
      const val = parseFloat(configVal);
      if (isNaN(val) || val <= 0) {
        state.config.maxSessionCost = null;
        ctx.saveChannelState(message.channel.id, state, { critical: true });
        await message.reply('Session cost cap removed.');
      } else {
        state.config.maxSessionCost = val;
        ctx.saveChannelState(message.channel.id, state, { critical: true });
        await message.reply(`Session cost cap set to **$${val.toFixed(2)}** — session auto-clears when exceeded.`);
      }
    } else {
      await message.reply('Usage: `!config show` | `!config turns <N>` | `!config continues <N>` | `!config timeout <minutes>` | `!config cost <$>`');
    }
  }
};
