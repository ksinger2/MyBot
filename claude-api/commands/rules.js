module.exports = {
  name: '!rules',
  aliases: [],
  adminOnly: false,
  description: 'Manage strict behavioral rules the bot must always follow for you',
  async run(message, arg, state, ctx) {
    const phone = message._signalSenderId || null;
    if (!phone) {
      await message.reply('Rules are Signal-only.');
      return;
    }

    const { addRule, removeRule, getProfile } = require('../user-profiles');
    const sub = arg.trim();

    // !rules list
    if (!sub || sub === 'list') {
      const profile = getProfile(phone);
      const rules = (profile && profile.rules) || [];
      if (rules.length === 0) {
        await message.reply('No rules set. Use `!rules add <rule>` to add one.');
      } else {
        const list = rules.map((r, i) => `${i + 1}. ${r.rule}`).join('\n');
        await message.reply(`Your rules:\n${list}`);
      }
      return;
    }

    // !rules add <rule>
    if (sub.startsWith('add ')) {
      const rule = sub.slice(4).trim();
      if (!rule) {
        await message.reply('Usage: `!rules add never use bullet points`');
        return;
      }
      addRule(phone, rule);
      await message.reply(`Rule added: "${rule}"`);
      return;
    }

    // !rules remove <keyword>
    if (sub.startsWith('remove ')) {
      const keyword = sub.slice(7).trim();
      if (!keyword) {
        await message.reply('Usage: `!rules remove <keyword>`');
        return;
      }
      const count = removeRule(phone, keyword);
      await message.reply(count > 0 ? `Removed ${count} rule(s) matching "${keyword}".` : `No rules matched "${keyword}".`);
      return;
    }

    await message.reply('Usage:\n`!rules list` — see your rules\n`!rules add <rule>` — add a rule\n`!rules remove <keyword>` — remove matching rules');
  }
};
