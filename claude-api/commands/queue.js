module.exports = {
  name: '!queue',
  aliases: [],
  adminOnly: false,
  description: 'Add work to the background queue',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply('Usage: `!queue <task>` — Add work to the background queue.\nExample: `!queue build a hello world express app`');
      return;
    }
    const { addItem } = require('../queue-storage');
    const item = addItem({
      prompt: arg,
      channelId: message.channel.id,
      userId: message.author.id,
      cwd: state.cwd,
      personality: state.personality,
      identity: { ...state.identity },
    });
    await message.reply(
      `Queued background task **#${item.id}**\n` +
      `📋 "${arg.substring(0, 100)}"\n` +
      `📁 \`${state.cwd}\`\n` +
      `Use \`!queued\` to check status, \`!dequeue ${item.id}\` to remove.`
    );
  }
};
