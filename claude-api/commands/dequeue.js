module.exports = {
  name: '!dequeue',
  aliases: [],
  adminOnly: false,
  description: 'Remove a pending item from the queue',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply('Usage: `!dequeue <#>` — Remove a pending item from the queue.');
      return;
    }
    const dequeueId = parseInt(arg, 10);
    if (isNaN(dequeueId)) {
      await message.reply('Usage: `!dequeue <#>` — provide the queue item number.');
      return;
    }
    const { removeItem } = require('../queue-storage');
    const removed = removeItem(dequeueId);
    if (!removed) {
      await message.reply(`No pending queue item #${dequeueId} found. Use \`!queued\` to see the list.`);
    } else {
      await message.reply(`Removed queue item **#${dequeueId}**: "${removed.prompt.substring(0, 80)}"`);
    }
  }
};
