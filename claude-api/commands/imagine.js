const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    await message.reply(`Sending to OpenAI: ${JSON.stringify(imgParams)}`);
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await openai.images.generate(imgParams);
      const base64 = response.data[0].b64_json;
      const buffer = Buffer.from(base64, 'base64');

      // Write to a tmp path so the Signal sender (sendLongMessage) can attach it.
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-'));
      const filePath = path.join(outDir, 'imagine.png');
      fs.writeFileSync(filePath, buffer);

      // Send via the Signal adapter directly with the image attached.
      const signalAdapter = ctx.signalAdapter;
      const chatId = message?._signalChatId;
      if (signalAdapter && chatId) {
        await signalAdapter.sendMessage(chatId, '', {
          attachments: [buffer], attachmentNames: ['imagine.png'],
        }).catch(err => message.reply(`Image send failed: ${err.message}`));
      } else {
        // Fallback — just point at the file path
        await message.reply(`Image generated: ${filePath}`);
      }
    } catch (err) {
      console.error('Image generation error:', err.message);
      await message.reply(`Image generation failed: ${err.message}`);
    }
  }
};
