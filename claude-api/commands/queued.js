module.exports = {
  name: '!queued',
  aliases: [],
  adminOnly: false,
  description: 'Check background queue status',
  async run(message, arg, state, ctx) {
    const { getQueue } = require('../queue-storage');
    const queue = getQueue();
    if (queue.length === 0) {
      await message.reply('Background queue is empty. Use `!queue <task>` to add work.');
      return;
    }
    const lines = queue.map(item => {
      const status = item.status === 'running' ? '🔄' : item.status === 'done' ? '✅' : item.status === 'failed' ? '❌' : '⏳';
      const prompt = item.prompt.length > 60 ? item.prompt.substring(0, 57) + '...' : item.prompt;
      return `${status} **#${item.id}** — ${prompt}\n  Status: ${item.status} | \`${item.cwd}\`${item.resultSummary ? `\n  Result: ${item.resultSummary}` : ''}`;
    });
    await ctx.sendLongMessage(message, `**Background Queue:**\n${lines.join('\n')}`, state.cwd);
  }
};
