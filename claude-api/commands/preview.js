const { spawn } = require('child_process');

module.exports = {
  name: '!preview',
  aliases: [],
  adminOnly: false,
  description: 'Smart preview — localhost link or Cloudflare tunnel',
  async run(message, arg, state, ctx) {
    if (arg === 'stop') {
      if (state._tunnel) {
        state._tunnel.kill();
        state._tunnel = null;
        state._tunnelPort = null;
        state._tunnelUrl = null;
        state._pendingPreview = null;
        await message.reply('Tunnel stopped.');
      } else {
        await message.reply('No tunnel is running.');
      }
      return;
    }

    const previewParts = arg ? arg.trim().split(/\s+/) : [];
    const previewPort = parseInt(previewParts[0], 10);
    const previewMode = previewParts[1] ? previewParts[1].toLowerCase() : null;

    if (!arg || isNaN(previewPort)) {
      if (state._tunnelUrl) {
        await message.reply(`**Active tunnel:** ${state._tunnelUrl} → localhost:${state._tunnelPort}\nUse \`!preview stop\` to close it.`);
      } else {
        await message.reply('No tunnel running. Usage: `!preview <port>` — e.g. `!preview 3000`');
      }
      return;
    }

    if (previewPort < 1 || previewPort > 65535) {
      await message.reply('Provide a valid port number. Usage: `!preview 3000`');
      return;
    }

    if (!previewMode) {
      state._pendingPreview = previewPort;
      await message.reply(
        `What device are you viewing on?\n` +
        `• Reply \`local\` — same PC (I'll give you a localhost link)\n` +
        `• Reply \`phone\` — mobile/tablet (I'll create a tunnel + magic link)`
      );
      return;
    }

    if (previewMode === 'local') {
      state._pendingPreview = null;
      await message.reply(`**Open on this PC:** http://localhost:${previewPort}`);
      return;
    }

    if (['phone', 'tunnel', 'mobile', 'remote'].includes(previewMode)) {
      state._pendingPreview = null;

      if (state._tunnel) {
        state._tunnel.kill();
        state._tunnel = null;
      }

      await message.reply(`Creating tunnel to localhost:${previewPort}...`);

      let publicIp = null;
      try {
        const resp = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
        publicIp = (await resp.text()).trim();
      } catch {}

      const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${previewPort}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let urlFound = false;
      const onData = (data) => {
        const text = data.toString();
        const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (urlMatch && !urlFound) {
          urlFound = true;
          state._tunnelUrl = urlMatch[0];
          state._tunnelPort = previewPort;
          const baseUrl = urlMatch[0];
          const magicUrl = publicIp ? `${baseUrl}?access=${publicIp}` : baseUrl;
          const ipNote = publicIp ? `\nYour public IP \`${publicIp}\` is pre-injected — just tap the link, no password needed.` : '';
          message.reply(
            `**Tunnel live! Tap this on your phone:**\n${magicUrl}${ipNote}\n\nUse \`!preview stop\` to close.`
          ).catch(() => {});
        }
      };

      tunnel.stdout.on('data', onData);
      tunnel.stderr.on('data', onData);

      tunnel.on('close', () => {
        if (state._tunnel === tunnel) {
          state._tunnel = null;
          state._tunnelPort = null;
          state._tunnelUrl = null;
        }
      });

      state._tunnel = tunnel;

      setTimeout(() => {
        if (!urlFound && state._tunnel === tunnel) {
          tunnel.kill();
          state._tunnel = null;
          message.reply(`Failed to start tunnel — is anything running on port ${previewPort}?`).catch(() => {});
        }
      }, 15000);
      return;
    }

    await message.reply(`Unknown mode \`${previewMode}\`. Use \`local\` or \`phone\`.`);
  }
};
