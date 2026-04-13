/**
 * concerts.js — !concerts [artist]
 *
 * Searches for upcoming shows near Alameda, CA for the given artist using the
 * Ticketmaster Discovery API (via the concert-tracker plugin's fetchTicketmaster).
 * If no artist is given, tells Claude to web-search Karen's favorite artists.
 * Falls back gracefully when the scraper/API is unavailable.
 */

const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY || '';
const TM_BASE = 'https://app.ticketmaster.com/discovery/v2';

async function searchTicketmaster(artist, city) {
  if (!TICKETMASTER_API_KEY) return null;
  try {
    const params = new URLSearchParams({
      apikey: TICKETMASTER_API_KEY,
      keyword: artist,
      size: '5',
      classificationName: 'music',
    });
    if (city) params.set('city', city);
    const res = await fetch(`${TM_BASE}/events.json?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data._embedded?.events || null;
  } catch (e) {
    console.error('[concerts] Ticketmaster search error:', e.message);
    return null;
  }
}

function formatEvent(event) {
  const artistName = event.name || 'Unknown Artist';
  const venue = event._embedded?.venues?.[0];
  const venueName = venue?.name || 'Unknown Venue';
  const city = venue?.city?.name || '';
  const state = venue?.state?.stateCode || '';
  const location = [city, state].filter(Boolean).join(', ');
  const dateInfo = event.dates?.start;
  const date = dateInfo?.localDate || 'TBD';
  const time = dateInfo?.localTime ? ` at ${dateInfo.localTime.slice(0, 5)}` : '';
  return `• ${artistName} — ${venueName}, ${location} — ${date}${time}`;
}

module.exports = {
  name: '!concerts',
  aliases: [],
  adminOnly: false,
  description: 'Search for upcoming concerts near Alameda, CA',
  async run(message, arg, state, ctx) {
    const artist = (arg || '').trim();

    if (!artist) {
      // No artist given — ask Claude to look up Karen's favorites and search
      if (state.busy) {
        await message.reply('Claude is still working. Use `!stop` first.');
        return;
      }
      const prompt = `The user wants to find upcoming concerts near Alameda, CA but didn't specify an artist. Look at the user's Spotify top artists from their profile context (or do a WebSearch for "concerts near Alameda CA 2026" if no profile data is available). List any upcoming shows in the next 3 months. Format as a plain list: artist, venue, date, city.`;
      await ctx.askClaude(message, prompt, state, ctx);
      return;
    }

    await message.reply(`Searching for ${artist} shows near Alameda, CA...`);

    if (!TICKETMASTER_API_KEY) {
      // No API key — fall back to Claude web search
      if (state.busy) {
        await message.reply('Claude is still working. Use `!stop` first.');
        return;
      }
      const prompt = `Search for upcoming ${artist} concerts near Alameda, CA in 2026. Use WebSearch to find events on Ticketmaster, StubHub, or SeatGeek. List: artist, venue, date, city. Keep it brief.`;
      await ctx.askClaude(message, prompt, state, ctx);
      return;
    }

    const events = await searchTicketmaster(artist, 'Alameda');
    // Broaden to Bay Area if nothing found near Alameda
    const finalEvents = (events && events.length > 0)
      ? events
      : await searchTicketmaster(artist, 'San Francisco');

    if (!finalEvents || finalEvents.length === 0) {
      await message.reply(`No upcoming ${artist} shows found near Alameda, CA on Ticketmaster. Try \`!prices ${artist}\` to check secondary market sites, or ask me to web-search for tickets.`);
      return;
    }

    const lines = [`**${artist} — Upcoming Shows Near Alameda, CA**`, ''];
    for (const event of finalEvents.slice(0, 8)) {
      lines.push(formatEvent(event));
    }
    lines.push('');
    lines.push(`Use \`!prices ${artist}\` to check ticket prices on StubHub, SeatGeek, and more.`);

    await message.reply(lines.join('\n'));
  },
};
