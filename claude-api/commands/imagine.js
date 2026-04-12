const OpenAI = require('openai');
const { AttachmentBuilder } = require('discord.js');

module.exports = {
  name: '!imagine',
  aliases: [],
  adminOnly: false,
  description: 'Generate an image with OpenAI',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply('Usage: `!imagine <description>` — e.g. `!imagine a cow in a spacesuit on the moon`');
      return;
    }
    if (!process.env.OPENAI_API_KEY) {
      await message.reply('No OpenAI API key configured.');
      return;
    }
    const imgParams = { model: 'gpt-image-1', prompt: arg, n: 1, size: '1024x1024', quality: 'low' };
    await message.reply(`**Sending to OpenAI:**\n\`\`\`json\n${JSON.stringify(imgParams, null, 2)}\n\`\`\``);
    await message.channel.sendTyping();
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await openai.images.generate(imgParams);
      const base64 = response.data[0].b64_json;
      const buffer = Buffer.from(base64, 'base64');
      const attachment = new AttachmentBuilder(buffer, { name: 'imagine.png' });
      await message.channel.send({ files: [attachment] });
    } catch (err) {
      console.error('Image generation error:', err.message);
      await message.reply(`Image generation failed: ${err.message}`);
    }
  }
};
