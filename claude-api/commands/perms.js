const path = require('path');

module.exports = {
  name: '!perms',
  aliases: [],
  adminOnly: false,
  description: 'List permissions for the current project',
  async run(message, arg, state, ctx) {
    const { listPermissions: _lp } = require('../project-permissions');
    const { allowed, owner } = _lp(state.cwd);
    const projectName = path.basename(state.cwd) || state.cwd;
    const lines = [`**Permissions for ${projectName}:**`, `Owner (full access): ${owner}`];
    if (allowed.length > 0) lines.push(`Also allowed: ${allowed.join(', ')}`);
    else lines.push('No additional users granted access.');
    await message.reply(lines.join('\n'));
  }
};
