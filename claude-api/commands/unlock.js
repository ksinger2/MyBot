/**
 * !unlock <PIN> — elevate channel to full write access.
 *
 * When BOT_UNLOCK_PIN is set, channels start in read-only mode (Claude can
 * chat, search, browse, but cannot Edit/Write/Bash). This command elevates
 * the channel to full access for the session (resets on restart).
 *
 * When BOT_UNLOCK_PIN is unset, this command is a no-op.
 */
module.exports = {
  name: '!unlock',
  aliases: [],
  adminOnly: false, // anyone can try to unlock — the PIN itself is the gate
  description: 'Elevate this channel to full write access (requires PIN)',
  async run(message, arg, state, ctx) {
    const pin = (arg || '').trim();
    const channelId = message.channel?.id || message._signalChatId || state?._channelId;

    if (!process.env.BOT_UNLOCK_PIN) {
      const reply = ctx._dreply || ((m, t) => m.reply(t));
      await reply(message, 'No PIN gate is configured — full access is already active.');
      return;
    }

    // Import the unlock function from bot.js
    const bot = require('../bot');
    if (typeof bot._tryUnlock === 'function' && bot._tryUnlock(channelId, pin)) {
      const reply = ctx._dreply || ((m, t) => m.reply(t));
      await reply(message, '🔓 Elevated — full write access for this channel until next restart.');
    } else {
      const reply = ctx._dreply || ((m, t) => m.reply(t));
      await reply(message, '🔒 Wrong PIN.');
    }
  },
};
