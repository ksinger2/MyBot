const { addSandboxUser, removeSandboxUser, listSandboxUsers, SANDBOX_ROOT, DEFAULT_TOOLS } = require('../sandbox');

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
    } else if (sub === 'list') {
      const all = listSandboxUsers();
      const entries = Object.entries(all);
      if (entries.length === 0) {
        await reply(message, 'No sandbox users configured.');
        return;
      }
      const lines = entries.map(([id, e]) =>
        `- **${e.name}** (\`${id}\`) → \`${e.cwd}\` [${e.linuxUser}]`
      );
      await reply(message, `**Sandbox users:**\n${lines.join('\n')}`);
    } else {
      await reply(message, 'Usage: `!sandbox add|remove|list`\n\n`!sandbox add <phone> <name> <path>` — create sandbox\n`!sandbox remove <phone>` — remove sandbox\n`!sandbox list` — show all sandboxes');
    }
  },
};
