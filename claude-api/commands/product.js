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

// H2 (auth hardening): closure-backed token, not process.env
const INTERNAL_TOKEN = require('../internal-token').getInternalToken();

// Strip conversational filler from natural language product requests,
// extract the store preference if mentioned, and return a clean search query.
function cleanProductQuery(raw) {
  let q = raw;
  // Extract store preference ("to my amazon cart", "on walmart", "from target")
  const storeMatch = q.match(/\b(?:to|from|on|at)\s+(?:my\s+)?(amazon|walmart|target)\b/i);
  const preferredStore = storeMatch ? storeMatch[1].toLowerCase() : null;

  // Strip leading intent verbs, including "i want (you) to <verb>" wrappers.
  // Only at start of query to avoid stripping brand names like "Best Buy".
  q = q.replace(/^(?:i\s+want\s+(?:(?:you\s+)?to\s+)?)?(?:add|find|get|search|look\s+for|order|put|buy)\b\s*/i, '');
  // Strip "to/from/on my [store] cart" phrases
  q = q.replace(/\b(?:to|from|on|at)\s+(?:my\s+)?(?:amazon|walmart|target)\s*(?:cart|wishlist|list)?\b/gi, '');
  // Strip adjective+deal phrases only when followed by "deal/price/value" (preserves "Good Earth", "Best Buy")
  q = q.replace(/\b(?:a\s+)?(?:nice|good|great|best|cheap|affordable)\s+(?:and\s+(?:nice|good|great|best|cheap|affordable)\s+)?(?:deal|price|value)\s*(?:on|for)?\b/gi, '');
  // Strip "a nice and good ... product" pattern (the whole filler phrase)
  q = q.replace(/\ba\s+(?:nice|good|great)\s+(?:and\s+(?:nice|good|great)\s+)?(?:deal\s+)?product\b/gi, '');
  q = q.replace(/\bthat\s+is\s+(?:a\s+)?/gi, '');
  q = q.replace(/\b(?:,\s*)?and\s+is\b/gi, '');
  q = q.replace(/\bproduct\b/gi, '');
  // Strip standalone filler pronouns (never part of a product name)
  q = q.replace(/\b(me|my|u|you|i)\b/gi, '');

  q = q.replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
  return { query: q || raw, preferredStore };
}

module.exports = {
  name: '!product',
  aliases: ['!search', '!products', '!shop', '!link', '!buy'],
  adminOnly: false,
  description: 'Search for products across Amazon, Walmart, and Target',
  cleanProductQuery,
  async run(message, arg, state, ctx) {
    const rawQuery = (arg || '').trim();

    if (!rawQuery) {
      await message.reply(
        'Usage: `!product <what you\'re looking for>`\n' +
        'Examples:\n' +
        '  `!product dove 0% aluminum deodorant`\n' +
        '  `!product airpods pro 2`\n' +
        '  `!product stanley tumbler 40oz`'
      );
      return;
    }

    const { query, preferredStore } = cleanProductQuery(rawQuery);
    const searchBody = { query };
    if (preferredStore) searchBody.stores = [preferredStore];

    ctx._dtyping(message.channel);

    try {
      const res = await fetch('http://localhost:3400/products/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': INTERNAL_TOKEN,
        },
        body: JSON.stringify(searchBody),
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
