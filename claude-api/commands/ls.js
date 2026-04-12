const fs = require('fs');
const path = require('path');

module.exports = {
  name: '!ls',
  aliases: [],
  adminOnly: false,
  description: 'List files in directory',
  async run(message, arg, state, ctx) {
    let target = arg ? (arg.startsWith('/') ? arg : path.join(state.cwd, arg)) : state.cwd;
    target = path.resolve(target);
    if (!target.startsWith('/workspace')) {
      await message.reply('Cannot list outside `/workspace/`.');
      return;
    }
    try {
      const entries = fs.readdirSync(target);
      const formatted = entries.map(e => {
        try {
          const full = path.join(target, e);
          const isDir = fs.statSync(full).isDirectory();
          return isDir ? `📁 ${e}/` : `📄 ${e}`;
        } catch { return `  ${e}`; }
      }).join('\n');
      await message.reply(`\`${target}\`:\n${formatted || '(empty)'}`);
    } catch {
      await message.reply(`Cannot read: \`${target}\``);
    }
  }
};
