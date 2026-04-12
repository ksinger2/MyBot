module.exports = {
  name: '!skills',
  aliases: [],
  adminOnly: false,
  description: 'List loaded skills',
  async run(message, arg, state, ctx) {
    try {
      const skills = ctx.listSkills();
      if (skills.length === 0) {
        await message.reply('No skills loaded. Skills are loaded from `skills/core/` directory.');
      } else {
        const list = skills.map(s => `• **${s.name}** — ${s.description}`).join('\n');
        await message.reply(`**Available Skills:**\n${list}`);
      }
    } catch (err) {
      await message.reply(`Error loading skills: ${err.message}`);
    }
  }
};
