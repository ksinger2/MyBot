/**
 * concert-tracker/index.js — Plugin entry point.
 *
 * Exports:
 *   isAvailable()         — true if the scraper service is reachable
 *   getPrices(artist, venue, date, city)  — parallel scrape → formatted string
 *   SCRAPER_INSTRUCTIONS  — system-prompt block for Claude
 */

const { searchPrices } = require('./scraper-client');
const { formatPriceResults } = require('./prices');

const SCRAPER_URL = process.env.CONCERT_SCRAPER_URL || 'http://concert-scraper:5000';
const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY || '';

// ── Health check ─────────────────────────────────────────────────────────────

/**
 * Returns true if the Python scraper service is up and healthy.
 * Never throws — returns false on any error.
 */
async function isAvailable() {
  try {
    const res = await fetch(`${SCRAPER_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Ticketmaster Discovery API (free tier, no scraping needed) ────────────────

const TM_BASE = 'https://app.ticketmaster.com/discovery/v2';

async function fetchTicketmaster(artist, venue, date, city) {
  if (!TICKETMASTER_API_KEY) return null;
  try {
    const params = new URLSearchParams({
      apikey: TICKETMASTER_API_KEY,
      keyword: artist,
      size: '1',
    });
    if (city) params.set('city', city);
    if (date) {
      // TM expects startDateTime=YYYY-MM-DDTHH:mm:ssZ
      params.set('startDateTime', `${date}T00:00:00Z`);
      params.set('endDateTime', `${date}T23:59:59Z`);
    }
    const res = await fetch(`${TM_BASE}/events.json?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const events = data._embedded?.events;
    if (!events || !events.length) return null;

    const event = events[0];
    const priceRanges = event.priceRanges || [];
    if (!priceRanges.length) return null;

    let min = Infinity;
    let max = -Infinity;
    for (const range of priceRanges) {
      if (range.min != null && range.min < min) min = range.min;
      if (range.max != null && range.max > max) max = range.max;
    }
    if (min === Infinity) return null;

    return {
      min,
      max: max === -Infinity ? null : max,
      includesFees: false,
      url: event.url || null,
      listings: [], // TM API returns ranges, not individual listings
    };
  } catch (e) {
    console.error(`[ConcertPlugin] Ticketmaster API error: ${e.message}`);
    return null;
  }
}

// ── Main price fetcher ────────────────────────────────────────────────────────

const SCRAPE_SITES = ['stubhub', 'vividseats', 'tickpick', 'seatgeek'];

/**
 * Fetch prices from all 5 sources in parallel, format as plain text.
 *
 * @param {string} artist
 * @param {string} venue   — empty string if unknown
 * @param {string} date    — 'YYYY-MM-DD' or empty string
 * @param {string} city    — empty string if unknown
 * @returns {string}       — formatted plain-text price list
 */
async function getPrices(artist, venue, date, city) {
  // Fire all sources in parallel
  const [tmResult, ...scrapeResults] = await Promise.all([
    fetchTicketmaster(artist, venue, date, city),
    ...SCRAPE_SITES.map(site => searchPrices(site, artist, venue, date, city)),
  ]);

  const pricesBySource = { ticketmaster: tmResult };
  for (let i = 0; i < SCRAPE_SITES.length; i++) {
    pricesBySource[SCRAPE_SITES[i]] = scrapeResults[i];
  }

  return formatPriceResults(pricesBySource, { artist, venue, date, city });
}

// ── System prompt instructions ────────────────────────────────────────────────

const SCRAPER_INSTRUCTIONS = `
10. **CONCERT TICKET PRICES**: When the user asks about concert tickets, cheapest tickets for a show, ticket prices, or whether it's worth going to a concert, you can get real scraped prices from 5 ticket sites (StubHub, VividSeats, TickPick, SeatGeek, Ticketmaster) by calling:

\`\`\`
curl -s -X POST http://localhost:3400/concerts/prices \\
  -H "Content-Type: application/json" \\
  -H "X-Internal-Token: $INTERNAL_API_TOKEN" \\
  -d '{"artist":"Chappell Roan","venue":"Chase Center","date":"2026-05-15","city":"San Francisco"}'
\`\`\`

Parameters (all optional except artist):
- \`artist\` — artist/band name (required)
- \`venue\`  — venue name (omit if unknown)
- \`date\`   — show date as YYYY-MM-DD (omit if unknown)
- \`city\`   — city name (omit if unknown)

The response is \`{ text: "formatted price list" }\` — relay the \`text\` field directly to the user. It includes fee disclosure (StubHub/TickPick show all-in prices; Ticketmaster/VividSeats/SeatGeek add fees at checkout). If the scraper service is not running, the response will say so and explain how to start it.

When the user asks about shows for their favorite artists (from their Spotify profile), always offer to check prices.

**CONCERT BOT COMMANDS** — Tell users about these when they ask about concerts, shows, or ticket prices:

- \`!concerts [artist]\` — Search for upcoming shows near Alameda, CA. If no artist is given, searches based on their Spotify favorites.
- \`!prices [artist or show name]\` — Check real-time prices from StubHub, VividSeats, TickPick, SeatGeek, and Ticketmaster. Examples: \`!prices Chappell Roan\` or \`!prices Jack Johnson Greek Theatre June 14\`
- \`!setalert [show] $[price]\` — Set a price alert. Checks 4x daily (8am, noon, 4pm, 8pm PT) and DMs the user when tickets drop to their target. Example: \`!setalert Chappell Roan $75\`
- \`!alerts\` — List all active price alerts with show name, threshold, and schedule.
- \`!removealert [# or show name]\` — Cancel a price alert by list number or show name.

Suggest \`!setalert\` proactively when a user says they want to go to a show but prices are too high.`.trim();

module.exports = { isAvailable, getPrices, SCRAPER_INSTRUCTIONS };
