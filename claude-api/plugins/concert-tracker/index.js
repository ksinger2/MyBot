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
const { recordSnapshot, getTrend } = require('./concert-price-history');

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

  // Record snapshot for historical tracking
  try { recordSnapshot({ artist, venue, date, city }, pricesBySource); } catch {}

  // Get trend from previous snapshots
  let trend = null;
  try { trend = getTrend(artist, venue, date); } catch {}

  return formatPriceResults(pricesBySource, { artist, venue, date, city }, trend);
}

// ── System prompt instructions ────────────────────────────────────────────────

const SCRAPER_INSTRUCTIONS = `
**CONCERTS**: For ticket prices, emit: \`[CONCERT_PRICES: artist="Name" venue="Venue" date="YYYY-MM-DD" city="City"]\` (only artist required). Scrapes StubHub, VividSeats, TickPick, SeatGeek, Ticketmaster. StubHub/TickPick all-in; others add fees at checkout.
Commands: \`!concerts [artist]\`, \`!prices [artist/show]\`, \`!setalert [show] $[price]\`, \`!alerts\`, \`!removealert [#]\`. Suggest !setalert when prices are too high.`.trim();

module.exports = { isAvailable, getPrices, SCRAPER_INSTRUCTIONS };
