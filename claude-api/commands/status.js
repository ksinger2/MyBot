module.exports = {
  name: '!status',
  aliases: [],
  adminOnly: false,
  description: 'Show session info for all channels',
  async run(message, arg, state, ctx) {
    const allChannels = [];
    for (const [chId, s] of ctx.channels) {
      const status = s.busy ? '🔄 WORKING' : (s.sessionId ? '💤 idle' : '⚫ no session');
      allChannels.push(`${chId}: ${status} | **${s.identity.name}** | ${s.personality} | \`${s.cwd}\`${s.sessionId ? ` | session \`${s.sessionId.substring(0, 8)}...\`` : ''}`);
    }
    await message.reply(
      `**Bot Status:**\n` +
      (allChannels.length ? allChannels.join('\n') : 'No channels active.') +
      `\n\nHard cap: ${ctx.MAX_TIMEOUT / 60000}min | Stall: ${ctx.STALL_THRESHOLDS.thinking / 60000}-${ctx.STALL_THRESHOLDS.browser / 60000}min (tiered) | Check-in: ${ctx.CHECKIN_INTERVAL / 60000}min | Max turns: ${ctx.DEFAULT_MAX_TURNS}`
    );
  }
};
