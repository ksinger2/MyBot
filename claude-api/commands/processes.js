const { execSync } = require('child_process');

module.exports = {
  name: '!processes',
  aliases: [],
  adminOnly: false,
  description: 'Show active Claude processes',
  async run(message, arg, state, ctx) {
    try {
      const output = execSync(
        'ps aux --sort=-%mem | head -1; ps aux --sort=-%mem | grep "[c]laude" || echo "No Claude processes running"',
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      const activeChannels = [];
      for (const [chId, s] of ctx.channels) {
        if (s.busy && s.process) {
          const ch = ctx.client.channels.cache.get(chId);
          const chName = ch ? `#${ch.name}` : chId;
          activeChannels.push(`${chName}: PID ${s.process.pid}`);
        }
      }

      const channelInfo = activeChannels.length
        ? `\n\n**Active bot tasks:**\n${activeChannels.join('\n')}`
        : '\n\n**No active bot tasks**';

      await message.reply(`**System Processes:**\n\`\`\`\n${output}\n\`\`\`${channelInfo}`);
    } catch (err) {
      await message.reply(`Error checking processes: ${err.message}`);
    }
  }
};
