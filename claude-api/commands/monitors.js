module.exports = {
  name: '!monitors',
  aliases: [],
  adminOnly: false,
  description: 'List all monitors',
  async run(message, arg, state, ctx) {
    const allMonitors = ctx.listMonitors();
    if (allMonitors.length === 0) {
      await message.reply('No monitors configured. Use `!monitor ci <repo>` or `!monitor health <url>` to set one up.');
      return;
    }
    const lines = allMonitors.map(m => {
      const status = m.enabled ? '🔄' : '⏸️';
      const lastAgo = m.lastCheck
        ? `${Math.round((Date.now() - new Date(m.lastCheck).getTime()) / 60000)}min ago`
        : 'never';
      const typeLabel = m.type === 'github-ci'
        ? `github-ci ${m.config.repo} (${m.config.branch || '*'})`
        : `url-health ${m.config.url}`;
      return `**#${m.id}** ${status} ${typeLabel} → ${m.action} | every ${m.pollInterval}min | last: ${lastAgo}`;
    });
    await ctx.sendLongMessage(message, `**Monitors:**\n${lines.join('\n')}`, state.cwd);
  }
};
