/**
 * !subdomain — Register/unregister a sandbox user's dev server port
 * so their personal subdomain (e.g. daniel.backtoirl.com) routes to it.
 *
 * Usage:
 *   !subdomain 3000      — register port, get URL
 *   !subdomain stop       — unregister port
 *   !subdomain            — show current status
 */

const { getSandboxUser } = require('../sandbox');
const { registerPort, unregisterPort, getTunnelUrl, getStatus } = require('../sandbox-tunnel');

const DOMAIN = 'backtoirl.com';

module.exports = {
  name: '!subdomain',
  aliases: ['!tunnel', '!domain'],
  adminOnly: false,
  description: 'Map your dev server port to your personal subdomain',

  async run(message, arg, state, ctx) {
    // Identify the sender — Signal proxy sets _signalSenderId
    const senderId = message._signalSenderId || message.author?.id;
    const sandboxUser = senderId ? getSandboxUser(senderId) : null;

    if (!sandboxUser) {
      // Could be the owner or an unregistered user
      const status = getStatus();
      if (Object.keys(status.mappings).length > 0) {
        const lines = Object.entries(status.mappings).map(
          ([name, info]) => `  ${name}.${DOMAIN} → localhost:${info.port}`
        );
        await message.reply(
          `This command is for sandbox users. Current subdomains:\n${lines.join('\n')}`
        );
      } else {
        await message.reply('This command is for sandbox users only. No subdomains are active.');
      }
      return;
    }

    const name = sandboxUser.name; // e.g. "Daniel"
    const nameLower = name.toLowerCase();
    const trimmed = (arg || '').trim().toLowerCase();

    // !subdomain stop — unregister
    if (trimmed === 'stop' || trimmed === 'off' || trimmed === 'down') {
      const had = unregisterPort(name);
      if (had) {
        await message.reply(`Subdomain stopped. ${nameLower}.${DOMAIN} is no longer routing.`);
      } else {
        await message.reply(`You don't have an active subdomain. Use \`!subdomain <port>\` to start one.`);
      }
      return;
    }

    // !subdomain (no args) — show status
    if (!trimmed) {
      const url = getTunnelUrl(name);
      if (url) {
        const status = getStatus();
        const port = status.mappings[nameLower]?.port;
        await message.reply(`**Your subdomain is live:**\n${url} → localhost:${port}\n\nUse \`!subdomain stop\` to disconnect.`);
      } else {
        await message.reply(`No subdomain active. Use \`!subdomain <port>\` to route ${nameLower}.${DOMAIN} to your dev server.`);
      }
      return;
    }

    // !subdomain <port> — register
    const port = parseInt(trimmed, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      await message.reply('Provide a valid port number (1-65535). Example: `!subdomain 3000`');
      return;
    }

    registerPort(name, port);
    const url = `https://${nameLower}.${DOMAIN}`;
    await message.reply(`**Subdomain live!**\n${url} → localhost:${port}\n\nAnyone can visit that URL to see your dev server. Use \`!subdomain stop\` when done.`);
  },
};
