/**
 * product.js — !product <query>
 *
 * Hits POST /products/search on localhost:3400 with the given natural-
 * language product query. Returns a formatted list of real product deep
 * links from Amazon, Walmart, and Target via the product-search plugin
 * (Brave Search primary, DuckDuckGo fallback).
 *
 * Usage:
 *   !product dove 0% aluminum deodorant
 *   !product airpods pro 2
 *   !product stanley tumbler 40oz
 *   !product kirkland laundry detergent
 */

const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || '';

module.exports = {
  name: '!product',
  aliases: ['!search', '!products', '!shop', '!link', '!buy'],
  adminOnly: false,
  description: 'Search for products across Amazon, Walmart, and Target',
  async run(message, arg, state, ctx) {
    const query = (arg || '').trim();

    if (!query) {
      await message.reply(
        'Usage: `!product <what you\'re looking for>`\n' +
        'Examples:\n' +
        '  `!product dove 0% aluminum deodorant`\n' +
        '  `!product airpods pro 2`\n' +
        '  `!product stanley tumbler 40oz`'
      );
      return;
    }

    ctx._dtyping(message.channel);

    try {
      const res = await fetch('http://localhost:3400/products/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': INTERNAL_TOKEN,
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        await message.reply(`Product search failed: ${err.error || res.statusText}`);
        return;
      }

      const data = await res.json();
      const text = data.text || 'No results.';

      // Chunk long messages so Signal doesn't drop them
      if (text.length <= 1900) {
        await message.reply(text);
      } else {
        let remaining = text;
        while (remaining.length > 0) {
          const cut = remaining.lastIndexOf('\n', 1900);
          const end = cut > 0 ? cut : 1900;
          await message.reply(remaining.slice(0, end));
          remaining = remaining.slice(end).trimStart();
        }
      }
    } catch (err) {
      console.error('[product cmd] error:', err.message);
      if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
        await message.reply('Product search service is not available right now. Try again in a moment.');
      } else {
        await message.reply(`Product search error: ${err.message}`);
      }
    }
  },
};
