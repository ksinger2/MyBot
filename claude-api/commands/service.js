const { execFileSync } = require('child_process');

module.exports = {
  name: '!service',
  aliases: [],
  adminOnly: true,
  description: 'Manage a PM2 background service',
  async run(message, arg, state, ctx) {
    const svcParts = arg ? arg.trim().split(/\s+/) : [];
    const svcAction = svcParts[0];
    const svcName = svcParts.slice(1).join(' ');
    const pm2Env = { ...process.env, PM2_HOME: '/home/node/.claude/.pm2' };

    // SECURITY (C3): use execFileSync with an argv array so `svcName` is
    // passed as a single literal argument. No shell, so `$(...)`, backticks,
    // `;`, `|`, `>`, etc. are all literal characters — no injection possible.
    if (svcAction === 'stop' && svcName) {
      try {
        execFileSync('pm2', ['delete', svcName], { encoding: 'utf-8', timeout: 5000, env: pm2Env });
        execFileSync('pm2', ['dump'], { encoding: 'utf-8', timeout: 5000, env: pm2Env });
        await message.reply(`Service **${svcName}** stopped and removed.`);
      } catch (err) {
        await message.reply(`Failed to stop service: ${err.message.substring(0, 200)}`);
      }
    } else if (svcAction === 'logs' && svcName) {
      try {
        const logs = execFileSync('pm2', ['logs', svcName, '--nostream', '--lines', '20'], { encoding: 'utf-8', timeout: 5000, env: pm2Env });
        await message.reply(`**Logs for ${svcName}:**\n\`\`\`\n${logs.substring(0, 1800)}\n\`\`\``);
      } catch (err) {
        await message.reply(`Failed to get logs: ${err.message.substring(0, 200)}`);
      }
    } else {
      await message.reply('Usage: `!service stop <name>` or `!service logs <name>`');
    }
  }
};
