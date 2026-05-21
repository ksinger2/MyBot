'use strict';

/**
 * !amazon — Amazon account management and cart operations.
 *
 * Subcommands:
 *   !amazon status   — check if logged in
 *   !amazon cart     — show cart contents
 *   !amazon login    — start interactive login (spawns a Claude session)
 *
 * Login uses the Playwright MCP through Claude so the user can interact
 * step-by-step (enter email, password, 2FA). Once logged in, the session
 * persists in the browser profile across container restarts.
 */

const amazonCart = require('../amazon-cart');

module.exports = {
  name: '!amazon',
  aliases: [],
  adminOnly: true,
  description: 'Amazon account management (status, cart, login)',
  async run(message, arg, state, ctx) {
    const sub = (arg || '').trim().toLowerCase().split(/\s+/)[0];

    if (!sub || sub === 'help') {
      await message.reply(
        '**!amazon** — Amazon account management\n\n' +
        '`!amazon status` — Check if logged in\n' +
        '`!amazon cart` — View cart contents\n' +
        '`!amazon login` — Log in to Amazon (interactive)'
      );
      return;
    }

    if (sub === 'status') {
      if (amazonCart.isBusy()) {
        await message.reply('Browser is busy with another operation — try again in a moment.');
        return;
      }
      ctx._dtyping(message.channel);
      try {
        const status = await amazonCart.checkLoginStatus();
        if (status.loggedIn) {
          await message.reply(`✅ Logged in to Amazon as **${status.name}**`);
        } else {
          await message.reply('❌ Not logged in to Amazon. Use `!amazon login` to sign in.');
        }
      } catch (err) {
        console.error('[amazon] status check failed:', err.message);
        await message.reply(`Amazon status check failed: ${err.message}`);
      }
      return;
    }

    if (sub === 'cart') {
      if (amazonCart.isBusy()) {
        await message.reply('Browser is busy — try again in a moment.');
        return;
      }
      ctx._dtyping(message.channel);
      try {
        const cart = await amazonCart.getCartContents();
        if (!cart.loggedIn) {
          await message.reply('❌ Not logged in to Amazon. Use `!amazon login` first.');
          return;
        }
        if (cart.items.length === 0) {
          await message.reply('🛒 Your Amazon cart is empty.');
        } else {
          const lines = cart.items.map((item, i) =>
            `${i + 1}. ${item.name}${item.price ? ` — ${item.price}` : ''}${item.qty !== '1' ? ` (x${item.qty})` : ''}`
          );
          const msg = `🛒 **Amazon Cart** (${cart.items.length} item${cart.items.length === 1 ? '' : 's'}):\n${lines.join('\n')}${cart.subtotal ? `\n\n**Subtotal:** ${cart.subtotal}` : ''}`;
          await message.reply(msg);
        }
        // Send screenshot if available
        if (cart.screenshotPath && message._signalChatId) {
          const fs = require('fs');
          if (fs.existsSync(cart.screenshotPath)) {
            const { signalAdapter } = require('../bot');
            if (signalAdapter?.ready) {
              await signalAdapter.sendMessage(message._signalChatId, '', [cart.screenshotPath]).catch(() => {});
            }
          }
        }
      } catch (err) {
        console.error('[amazon] cart check failed:', err.message);
        await message.reply(`Amazon cart check failed: ${err.message}`);
      }
      return;
    }

    if (sub === 'login') {
      await message.reply(
        '🔐 Starting Amazon login — I\'ll walk you through it step by step.\n\n' +
        'Tell me your Amazon email when you\'re ready, or say "cancel" to stop.'
      );
      // Mark this channel as in amazon-login mode so the next messages
      // are handled by the interactive login flow
      state._amazonLoginPending = true;
      return;
    }

    await message.reply(`Unknown subcommand: \`${sub}\`. Try \`!amazon help\`.`);
  },
};
