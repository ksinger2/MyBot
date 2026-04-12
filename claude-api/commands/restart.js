const fs = require('fs');
const path = require('path');

module.exports = {
  name: '!restart',
  aliases: [],
  adminOnly: true,
  description: 'Restart bot container',
  async run(message, arg, state, ctx) {
    await message.reply('Restarting... be right back.');
    try { fs.writeFileSync(path.join(__dirname, '..', '.restart-channel'), message.channel.id); } catch {}
    try { fs.writeFileSync(path.join('/home/node/.claude', '.clean-shutdown'), Date.now().toString()); } catch {}
    for (const [chId, s] of ctx.channels) {
      s.activeTask = null;
      ctx.saveChannelState(chId, s);
    }
    ctx.flushPendingWrites();
    const restartKills = [];
    for (const [, s] of ctx.channels) {
      if (s.process) restartKills.push(ctx.forceKillProcess(s.process));
    }
    await Promise.all(restartKills);
    setTimeout(() => process.exit(0), 500);
  }
};
