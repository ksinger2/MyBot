/**
 * scraper-client.js — HTTP client for the concert-scraper Python service.
 *
 * Mirrors /workspace/ConcertTracker/concert-bot/services/scraper-client.js
 * but targets the MyBot sidecar (port 5001 externally, 5000 inside the container).
 *
 * Two exported functions:
 *   searchPrices(artist, venue, date, city) — search by metadata (returns raw result)
 *   scrapeUrl(url)                          — scrape a known event URL directly
 *
 * Both return null on any connection/HTTP error so callers can handle
 * "scraper not running" gracefully.
 */

const SCRAPER_URL = process.env.CONCERT_SCRAPER_URL || 'http://concert-scraper:5000';

function mapListings(raw) {
  return (raw || []).map(l => ({
    price: l.price,
    section: l.section || '',
    row: l.row || '',
    labels: l.labels || [],
    quantity: l.quantity,
    listingId: l.listing_id || null,
    url: l.url || null,
  }));
}

function mapResult(data) {
  return {
    min: data.min,
    max: data.max,
    includesFees: data.includes_fees,
    url: data.url,
    sectionBreakdown: data.section_breakdown || null,
    listings: mapListings(data.listings),
  };
}

/**
 * Search for a concert by metadata and scrape the first matching event page.
 * @param {string} site    - 'stubhub' | 'vividseats' | 'tickpick' | 'seatgeek'
 * @param {string} artist
 * @param {string} venue
 * @param {string} date    - 'YYYY-MM-DD' or empty string
 * @param {string} city
 * @returns {Object|null}
 */
async function searchPrices(site, artist, venue, date, city) {
  try {
    const res = await fetch(`${SCRAPER_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site, artist, venue, date, city }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) return null;
    return mapResult(await res.json());
  } catch (e) {
    // ECONNREFUSED / timeout → scraper not running
    console.error(`[ConcertScraper] searchPrices error (${site}): ${e.message}`);
    return null;
  }
}

/**
 * Scrape a known direct event URL.
 * @param {string} url
 * @returns {Object|null}
 */
async function scrapeUrl(url) {
  try {
    const res = await fetch(`${SCRAPER_URL}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    return mapResult(await res.json());
  } catch (e) {
    console.error(`[ConcertScraper] scrapeUrl error: ${e.message}`);
    return null;
  }
}

module.exports = { searchPrices, scrapeUrl };
