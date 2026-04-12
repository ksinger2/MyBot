module.exports = {
  name: '!tasks',
  aliases: [],
  adminOnly: false,
  description: 'List active tasks',
  async run(message, arg, state, ctx) {
    const { loadActiveTasks, formatTaskList } = require('../tasks-storage');
    const active = loadActiveTasks();
    if (active.length === 0) {
      await message.reply('No active tasks. Add some via the evening check-in or they\'ll show up after you chat with me about your plans!');
    } else {
      await message.reply(`**Active Tasks:**\n${formatTaskList(active)}\n\nUse \`!done <#>\` to mark done, \`!done all\` to clear all.`);
    }
  }
};
