module.exports = {
  name: '!startproject',
  aliases: [],
  adminOnly: false,
  description: 'Create a new project with template',
  async run(message, arg, state, ctx) {
    if (state.busy) {
      await message.reply('Claude is still working. Use `!stop` first.');
      return;
    }
    if (state.wizard) {
      await message.reply('A wizard is already active. Use `!cancel` to cancel it first.');
      return;
    }
    const { startProjectWizard } = require('../wizards/startproject');
    await startProjectWizard(state, message);
  }
};
