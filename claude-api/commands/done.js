module.exports = {
  name: '!done',
  aliases: [],
  adminOnly: false,
  description: 'Mark a task as done',
  async run(message, arg, state, ctx) {
    const { markDone } = require('../tasks-storage');
    const result = markDone(arg || '');
    await message.reply(result);
  }
};
