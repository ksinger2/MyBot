/**
 * prices.js — !prices [artist or show name]
 *
 * Hits POST /concerts/prices on localhost:3400 with the given artist/show query.
 * Returns the formatted price table from all 5 sources.
 *
 * Usage:
 *   !prices Chappell Roan
 *   !prices Jack Johnson Greek Theatre June 14
 */

const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || '';

module.exports = {
  name: '!prices',
  aliases: [],
  adminOnly: false,
  description: 'Check ticket prices from StubHub, VividSeats, TickPick, SeatGeek, and Ticketmaster',
  async run(message, arg, state, ctx) {
    const query = (arg || '').trim();

    if (!query) {
      await message.reply(
        'Usage: `!prices <artist or show name>`\n' +
        'Examples:\n' +
        '  `!prices Chappell Roan`\n' +
        '  `!prices Jack Johnson Greek Theatre June 14`'
      );
      return;
    }

    await message.reply(`Checking ticket prices for "${query}"...`);

    // Parse the query — treat everything as the artist name for a broad search.
    // The /concerts/prices endpoint accepts artist, venue, date, city but only
    // artist is required. We send the whole query as artist for best match.
    const body = { artist: query, city: 'Alameda' };

    try {
      const res = await fetch('http://localhost:3400/concerts/prices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': INTERNAL_TOKEN,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000), // scraping can be slow
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        await message.reply(`Price check failed: ${err.error || res.statusText}`);
        return;
      }

      const data = await res.json();
      const text = data.text || 'No price data returned.';

      // Split into chunks if too long for one message
      if (text.length <= 1900) {
        await message.reply(text);
      } else {
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
          const cut = remaining.lastIndexOf('\n', 1900);
          const end = cut > 0 ? cut : 1900;
          chunks.push(remaining.slice(0, end));
          remaining = remaining.slice(end).trimStart();
        }
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      }
    } catch (err) {
      console.error('[prices cmd] error:', err.message);
      if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
        await message.reply('Concert price service is not available right now. Try again in a moment.');
      } else {
        await message.reply(`Price check error: ${err.message}`);
      }
    }
  },
};
