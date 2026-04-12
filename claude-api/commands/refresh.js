const fs = require('fs');
const path = require('path');

module.exports = {
  name: '!refresh',
  aliases: [],
  adminOnly: false,
  description: 'Nuclear reset: kill all, clear state, restart',
  async run(message, arg, state, ctx) {
    const statusMsg = await message.reply('Refreshing... killing processes, clearing all state, and restarting.');
    const refreshKills = [];
    for (const [, s] of ctx.channels) {
      if (s.process) refreshKills.push(ctx.forceKillProcess(s.process));
    }
    await Promise.all(refreshKills);
    for (const [chId, s] of ctx.channels) {
      s.sessionId = null;
      s.busy = false;
      s.process = null;
      s.queue = [];
      s.activeTask = null;
      s.progress = ctx.freshProgress();
      ctx.saveChannelState(chId, s);
    }
    ctx.flushPendingWrites();
    try {
      const sessionDirs = ['/home/node/.claude/projects'];
      for (const dir of sessionDirs) {
        if (fs.existsSync(dir)) {
          const { execFileSync } = require('child_process');
          execFileSync('find', [dir, '-name', '*.jsonl', '-delete'], { timeout: 5000 });
        }
      }
      console.log('[refresh] Cleared CLI session files');
    } catch (err) {
      console.error('[refresh] Failed to clear sessions:', err.message);
    }
    try { fs.writeFileSync(path.join('/home/node/.claude', '.clean-shutdown'), Date.now().toString()); } catch {}
    try { fs.writeFileSync(path.join(__dirname, '..', '.restart-channel'), message.channel.id); } catch {}
    setTimeout(() => process.exit(0), 500);
  }
};
