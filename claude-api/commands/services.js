const { execSync } = require('child_process');

module.exports = {
  name: '!services',
  aliases: [],
  adminOnly: false,
  description: 'List PM2 background services',
  async run(message, arg, state, ctx) {
    try {
      const pm2Env = { ...process.env, PM2_HOME: '/home/node/.claude/.pm2' };
      const output = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000, env: pm2Env });
      const processes = JSON.parse(output);
      if (processes.length === 0) {
        await message.reply('No background services running. Claude can start dev servers with PM2.');
        return;
      }
      const lines = processes.map(p => {
        const status = p.pm2_env?.status || 'unknown';
        const mem = p.monit ? Math.round(p.monit.memory / 1024 / 1024) : 0;
        const uptime = p.pm2_env?.pm_uptime ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 1000) : 0;
        const uptimeStr = uptime > 3600 ? `${Math.round(uptime / 3600)}h` : uptime > 60 ? `${Math.round(uptime / 60)}m` : `${uptime}s`;
        return `**${p.name}** — ${status} | PID ${p.pid} | ${mem}MB | up ${uptimeStr} | \`${p.pm2_env?.cwd || '?'}\``;
      });
      await message.reply(`**Background Services (PM2):**\n${lines.join('\n')}`);
    } catch (err) {
      await message.reply(`Error listing services: ${err.message.substring(0, 200)}`);
    }
  }
};
