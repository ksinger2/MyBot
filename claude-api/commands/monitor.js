module.exports = {
  name: '!monitor',
  aliases: [],
  adminOnly: false,
  description: 'Create or manage monitors (CI, health checks)',
  async run(message, arg, state, ctx) {
    const parts = message.content.trim().split(/\s+/);
    const monArgs = parts.slice(1);
    const subCmd = (monArgs[0] || '').toLowerCase();

    if (subCmd === 'ci') {
      const repo = monArgs[1] || '*';
      if (repo !== '*' && !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
        await message.reply('Invalid repo format. Use `owner/repo` (e.g. `myuser/myrepo`).');
        return;
      }
      const flags = monArgs.slice(2).join(' ');
      const branchMatch = flags.match(/--branch[= ](\S+)/);
      const actionMatch = flags.match(/--action[= ](fix|notify)/);
      const intervalMatch = flags.match(/--interval[= ](\d+)/);
      const mon = ctx.addMonitor({
        type: 'github-ci',
        channelId: message.channel.id,
        action: actionMatch ? actionMatch[1] : 'notify',
        config: { repo, branch: branchMatch ? branchMatch[1] : 'main' },
        pollInterval: intervalMatch ? parseInt(intervalMatch[1], 10) : 5,
        cwd: state.cwd,
      });
      const { scheduleMonitor } = require('../monitor-runner');
      scheduleMonitor(mon, ctx.client);
      await message.reply(
        `Monitor **#${mon.id}** created!\n` +
        `🔄 **github-ci** — ${repo} (${mon.config.branch})\n` +
        `⚡ Action: ${mon.action} | Every ${mon.pollInterval}min\n` +
        `Use \`!monitors\` to list, \`!monitor remove ${mon.id}\` to delete.`
      );
    } else if (subCmd === 'health') {
      const url = monArgs[1];
      if (!url) {
        await message.reply('Usage: `!monitor health <url>` — e.g. `!monitor health http://localhost:3400/health`');
        return;
      }
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          await message.reply('Only `http` and `https` URLs are supported.');
          return;
        }
      } catch {
        await message.reply('Invalid URL format.');
        return;
      }
      const flags = monArgs.slice(2).join(' ');
      const actionMatch = flags.match(/--action[= ](fix|notify)/);
      const statusMatch = flags.match(/--status[= ](\d+)/);
      const intervalMatch = flags.match(/--interval[= ](\d+)/);
      const mon = ctx.addMonitor({
        type: 'url-health',
        channelId: message.channel.id,
        action: actionMatch ? actionMatch[1] : 'notify',
        config: { url, expectStatus: statusMatch ? parseInt(statusMatch[1], 10) : 200 },
        pollInterval: intervalMatch ? parseInt(intervalMatch[1], 10) : 5,
        cwd: state.cwd,
      });
      const { scheduleMonitor } = require('../monitor-runner');
      scheduleMonitor(mon, ctx.client);
      await message.reply(
        `Monitor **#${mon.id}** created!\n` +
        `🔄 **url-health** — ${url}\n` +
        `⚡ Action: ${mon.action} | Every ${mon.pollInterval}min\n` +
        `Use \`!monitors\` to list, \`!monitor remove ${mon.id}\` to delete.`
      );
    } else if (subCmd === 'remove') {
      const id = parseInt(monArgs[1], 10);
      if (isNaN(id)) {
        await message.reply('Usage: `!monitor remove <id>`');
        return;
      }
      const removed = ctx.removeMonitor(id);
      if (!removed) {
        await message.reply(`No monitor #${id} found.`);
      } else {
        const { cancelMonitor } = require('../monitor-runner');
        cancelMonitor(id);
        await message.reply(`Removed monitor **#${id}** (${removed.type}).`);
      }
    } else if (subCmd === 'pause') {
      const id = parseInt(monArgs[1], 10);
      if (isNaN(id)) { await message.reply('Usage: `!monitor pause <id>`'); return; }
      const mon = ctx.updateMonitor(id, { enabled: false });
      if (!mon) { await message.reply(`No monitor #${id} found.`); return; }
      const { cancelMonitor } = require('../monitor-runner');
      cancelMonitor(id);
      await message.reply(`Paused monitor **#${id}**. Use \`!monitor resume ${id}\` to re-enable.`);
    } else if (subCmd === 'resume') {
      const id = parseInt(monArgs[1], 10);
      if (isNaN(id)) { await message.reply('Usage: `!monitor resume <id>`'); return; }
      const mon = ctx.updateMonitor(id, { enabled: true });
      if (!mon) { await message.reply(`No monitor #${id} found.`); return; }
      const { scheduleMonitor } = require('../monitor-runner');
      scheduleMonitor(mon, ctx.client);
      await message.reply(`Resumed monitor **#${id}**.`);
    } else if (subCmd === 'check') {
      const id = parseInt(monArgs[1], 10);
      if (isNaN(id)) { await message.reply('Usage: `!monitor check <id>`'); return; }
      const mon = ctx.getMonitor(id);
      if (!mon) { await message.reply(`No monitor #${id} found.`); return; }
      await message.reply(`Running immediate check for monitor **#${id}**...`);
      const { runPoll } = require('../monitor-runner');
      runPoll(id, ctx.client).catch(err => {
        message.reply(`Check failed: ${err.message}`).catch(() => {});
      });
    } else {
      await message.reply(
        `**Monitor Commands:**\n` +
        `\`!monitor ci <repo> [--branch=main] [--action=fix|notify]\`\n` +
        `\`!monitor health <url> [--action=fix|notify]\`\n` +
        `\`!monitor remove <id>\` · \`!monitor pause <id>\` · \`!monitor resume <id>\`\n` +
        `\`!monitor check <id>\` — force immediate poll\n` +
        `\`!monitors\` — list all monitors`
      );
    }
  }
};
