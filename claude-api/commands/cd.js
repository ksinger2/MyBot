const fs = require('fs');
const path = require('path');

module.exports = {
  name: '!cd',
  aliases: [],
  adminOnly: false,
  description: 'Show or change project directory',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply(`Current working directory: \`${state.cwd}\``);
    } else {
      const target = arg.startsWith('/') ? arg : path.join(state.cwd, arg);
      const resolved = path.resolve(target);
      if (!resolved.startsWith('/workspace')) {
        await message.reply('Cannot navigate outside `/workspace/`.');
        return;
      }
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        state.cwd = resolved;
        state.sessionId = null;
        ctx.saveChannelState(message.channel.id, state);
        await message.reply(`Working directory: \`${target}\`\nSession cleared for new project context.`);
      } else {
        await message.reply(`Directory not found: \`${target}\`\nAvailable in /workspace:\n${ctx.listWorkspaceDirs()}`);
      }
    }
  }
};
