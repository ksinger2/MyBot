const { addSandboxUser, removeSandboxUser, listSandboxUsers, linkGroupChat, unlinkGroupChat, getSandboxUser, setCloudflareToken, purgeSandboxUser, SANDBOX_ROOT, DEFAULT_TOOLS } = require('../sandbox');

module.exports = {
  name: '!sandbox',
  aliases: [],
  adminOnly: true,
  description: 'Manage per-user sandbox environments (!sandbox add/remove/list)',
  async run(message, arg, state, ctx) {
    const parts = (arg || '').split(/\s+/);
    const sub = parts[0]?.toLowerCase();
    const reply = ctx._dreply || ((m, t) => m.reply(t));

    if (sub === 'add') {
      // !sandbox add <phone/id> <name> [tools]
      // Path auto-assigned to /sandbox/<name>
      const [, senderId, name, ...toolParts] = parts;
      if (!senderId || !name) {
        await reply(message, 'Usage: `!sandbox add <phone-or-id> <name> [tools]`\nExample: `!sandbox add +15551234567 Daniel`\nWorkspace auto-created at `/sandbox/<name>`.');
        return;
      }
      try {
        const tools = toolParts.length > 0 ? toolParts.join(',') : undefined;
        const entry = addSandboxUser(senderId, name, undefined, tools);
        await reply(message, `Sandbox created for **${name}**:\n- ID: \`${senderId}\`\n- Dir: \`${entry.cwd}\`\n- User: \`${entry.linuxUser}\`\n- Tools: ${entry.allowedTools}\n\n/workspace is hidden from this user (mount namespace isolation).`);
      } catch (err) {
        await reply(message, `Failed to create sandbox: ${err.message}`);
      }
    } else if (sub === 'remove') {
      const senderId = parts[1];
      if (!senderId) {
        await reply(message, 'Usage: `!sandbox remove <phone-or-id>`');
        return;
      }
      const removed = removeSandboxUser(senderId);
      if (removed) {
        await reply(message, `Removed sandbox for **${removed.name}**. Files in \`${removed.cwd}\` are preserved.`);
      } else {
        await reply(message, `No sandbox found for \`${senderId}\`.`);
      }
    } else if (sub === 'link') {
      // !sandbox link <phone-or-id>  — link current group chat to a sandbox user
      const senderId = parts[1];
      if (!senderId) {
        await reply(message, 'Usage: `!sandbox link <phone-or-id>` (run in the group chat you want to link)');
        return;
      }
      const isGroup = message.chatId !== message.senderId;
      if (!isGroup) {
        await reply(message, 'Run this command in the group chat you want to link, not a DM.');
        return;
      }
      try {
        const entry = linkGroupChat(message.chatId, senderId);
        await reply(message, `Group linked to **${entry.name}**'s sandbox (\`${entry.cwd}\`). All members now get sandbox tools and shared session.`);
      } catch (err) {
        await reply(message, `Failed to link group: ${err.message}`);
      }
    } else if (sub === 'unlink') {
      const isGroup = message.chatId !== message.senderId;
      if (!isGroup) {
        await reply(message, 'Run this command in the group chat you want to unlink.');
        return;
      }
      const removed = unlinkGroupChat(message.chatId);
      if (removed) {
        await reply(message, 'Group unlinked from sandbox. Standard group permissions restored.');
      } else {
        await reply(message, 'This group is not linked to any sandbox.');
      }
    } else if (sub === 'list') {
      const all = listSandboxUsers();
      const entries = Object.entries(all).filter(([k]) => k !== '_groupLinks');
      if (entries.length === 0) {
        await reply(message, 'No sandbox users configured.');
        return;
      }
      const lines = entries.map(([id, e]) =>
        `- **${e.name}** (\`${id}\`) → \`${e.cwd}\` [${e.linuxUser}]`
      );
      const groupLinks = all._groupLinks || {};
      const linkLines = Object.entries(groupLinks).map(([chatId, link]) => {
        const user = getSandboxUser(link.sandboxSenderId);
        return `- Group \`${chatId.slice(0, 8)}…\` → **${user?.name || link.sandboxSenderId}**`;
      });
      let msg = `**Sandbox users:**\n${lines.join('\n')}`;
      if (linkLines.length > 0) msg += `\n\n**Linked groups:**\n${linkLines.join('\n')}`;
      await reply(message, msg);
    } else if (sub === 'cloudflare') {
      const senderId = parts[1];
      const token = parts[2];
      if (!senderId || !token) {
        await reply(message, 'Usage: `!sandbox cloudflare <phone-or-id> <scoped-api-token>`');
        return;
      }
      try {
        const entry = setCloudflareToken(senderId, token);
        await reply(message, `Cloudflare API token set for **${entry.name}**. Token will be injected as $CLOUDFLARE_API_TOKEN in their sessions.`);
      } catch (err) {
        await reply(message, `Failed: ${err.message}`);
      }
    } else if (sub === 'purge') {
      const senderId = parts[1];
      if (!senderId) {
        await reply(message, 'Usage: `!sandbox purge <phone-or-id>` — removes sandbox config, Linux user, home dir, and workspace files');
        return;
      }
      try {
        const entry = purgeSandboxUser(senderId);
        if (entry) {
          await reply(message, `Purged sandbox **${entry.name}**: config removed, Linux user deleted, workspace \`${entry.cwd}\` deleted.`);
        } else {
          await reply(message, `No sandbox found for \`${senderId}\`.`);
        }
      } catch (err) {
        await reply(message, `Purge failed: ${err.message}`);
      }
    } else {
      await reply(message, 'Usage: `!sandbox add|remove|purge|link|unlink|list|cloudflare`\n\n`!sandbox add <phone> <name>` — create sandbox\n`!sandbox remove <phone>` — remove config (keep files)\n`!sandbox purge <phone>` — remove config + delete all files\n`!sandbox link <phone>` — link this group to a sandbox\n`!sandbox unlink` — unlink this group\n`!sandbox cloudflare <phone> <token>` — set scoped CF token\n`!sandbox list` — show all sandboxes');
    }
  },
};
