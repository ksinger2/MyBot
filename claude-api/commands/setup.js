module.exports = {
  name: '!setup',
  aliases: [],
  adminOnly: false,
  description: 'Generate a setup link for profile configuration',
  async run(message, arg, state, ctx) {
    const senderId = message.author?.id || message._signalSenderId;
    const { isSignalOwner: _iso4 } = require('../project-permissions');
    const targetPhone = (arg.trim() && _iso4(senderId)) ? arg.trim() : senderId;
    const baseUrl = process.env.BOT_PUBLIC_URL || process.env.PUBLIC_URL || `http://localhost:3400`;

    // Request an ephemeral token from the internal API so the setup URL
    // actually works (the /setup/:userId page requires ?t= to load).
    let setupUrl;
    try {
      const http = require('http');
      const tokenRes = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ userId: targetPhone });
        const req = http.request({
          hostname: 'localhost', port: 3400, path: '/internal/setup-token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': process.env.INTERNAL_API_TOKEN || '',
            'Content-Length': Buffer.byteLength(body),
          },
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { reject(new Error('bad response')); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      setupUrl = `${baseUrl}${tokenRes.url}`;
    } catch (err) {
      // Fallback: generate URL without token (will 403 but at least user sees an error)
      console.warn(`[!setup] failed to get ephemeral token: ${err.message}`);
      setupUrl = `${baseUrl}/setup/${encodeURIComponent(targetPhone)}`;
    }

    // Privacy: in group chats, don't show phone number or link publicly.
    // Send the link via DM instead.
    const isGroup = message._signalChatId && message._signalChatId !== message._signalSenderId;
    if (isGroup) {
      try {
        const { signalAdapter } = require('../bot');
        if (signalAdapter && signalAdapter.ready) {
          await signalAdapter.sendMessage(targetPhone, `Here's your setup link:\n${setupUrl}\n\nTap it to set your name, location, connect calendar & Spotify.`);
          await message.reply('Sent you a DM with your setup link.');
        } else {
          await message.reply('DM me directly for your setup link.');
        }
      } catch {
        await message.reply('DM me directly for your setup link.');
      }
    } else {
      await message.reply(`Here's your setup link:\n${setupUrl}\n\nTap it to set your name, location, connect calendar & Spotify.`);
    }
  }
};
