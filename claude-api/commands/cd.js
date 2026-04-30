const fs = require('fs');
const path = require('path');
const { getSandboxUser } = require('../sandbox');

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
      const senderId = message._signalSenderId;
      const sandbox = senderId ? getSandboxUser(senderId) : null;
      if (sandbox) {
        if (!resolved.startsWith(sandbox.cwd)) {
          await message.reply(`You can only work in \`${sandbox.cwd}/\`.`);
          return;
        }
      } else if (!resolved.startsWith('/workspace')) {
        await message.reply('Cannot navigate outside `/workspace/`.');
        return;
      }
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        state.cwd = resolved;
        state.sessionId = null;
        ctx.saveChannelState(message.channel.id, state, { critical: true });
        await message.reply(`Working directory: \`${target}\`\nSession cleared for new project context.`);
      } else {
        await message.reply(`Directory not found: \`${target}\`\nAvailable in /workspace:\n${ctx.listWorkspaceDirs()}`);
      }
    }
  }
};
