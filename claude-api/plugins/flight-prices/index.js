/**
 * flight-prices/index.js — Delta flight price tracking plugin
 *
 * Tracks specific routes over time and alerts on price drops.
 * Uses Google Flights via the bot's existing Playwright MCP tools
 * (no external API key required).
 *
 * Storage: /app/data/flight-price-history.json
 * Format: { "SFO-JFK-2026-05-15": { route, snapshots: [{ timestamp, prices }] } }
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('../../atomic-write');

const HISTORY_FILE = path.join('/app/data', 'flight-price-history.json');
const MAX_SNAPSHOTS = 60; // ~2 months of twice-daily checks

// ── Storage ──────────────────────────────────────────────────────────────────

function _load() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {}
  return {};
}

function _save(data) {
  try { atomicWriteJsonSync(HISTORY_FILE, data); } catch (e) {
    console.error(`[flight-prices] save failed: ${e.message}`);
  }
}

function routeKey(origin, destination, date) {
  return `${(origin || '').toUpperCase()}-${(destination || '').toUpperCase()}-${date || 'flex'}`;
}

/**
 * Record a price snapshot for a route.
 * Called after a price check (manual or scheduled).
 */
function recordSnapshot(origin, destination, date, prices) {
  const key = routeKey(origin, destination, date);
  const data = _load();

  if (!data[key]) {
    data[key] = {
      origin: (origin || '').toUpperCase(),
      destination: (destination || '').toUpperCase(),
      date: date || null,
      snapshots: [],
    };
  }

  data[key].snapshots.push({
    timestamp: new Date().toISOString(),
    lowestPrice: prices.lowest || null,
    airline: prices.airline || 'Delta',
    prices: prices.options || [], // [{ price, stops, duration, airline, departure, arrival }]
  });

  while (data[key].snapshots.length > MAX_SNAPSHOTS) data[key].snapshots.shift();
  _save(data);
  console.log(`[flight-prices] Recorded: ${key} → $${prices.lowest || '?'}`);
}

/**
 * Get trend for a route.
 */
function getTrend(origin, destination, date) {
  const key = routeKey(origin, destination, date);
  const data = _load();
  const route = data[key];
  if (!route || route.snapshots.length < 2) return null;

  const latest = route.snapshots[route.snapshots.length - 1];
  const previous = route.snapshots[route.snapshots.length - 2];

  if (!latest.lowestPrice || !previous.lowestPrice) return null;
  const delta = latest.lowestPrice - previous.lowestPrice;

  // Longer trend
  let longTrend = 'stable';
  if (route.snapshots.length >= 3) {
    const recent = route.snapshots.slice(-5);
    const prices = recent.map(s => s.lowestPrice).filter(Boolean);
    if (prices.length >= 3) {
      const totalDelta = prices[prices.length - 1] - prices[0];
      if (totalDelta < -15) longTrend = 'falling';
      else if (totalDelta > 15) longTrend = 'rising';
    }
  }

  // All-time low
  const allPrices = route.snapshots.map(s => s.lowestPrice).filter(Boolean);
  const allTimeLow = Math.min(...allPrices);
  const isAtLow = latest.lowestPrice <= allTimeLow;

  let message = '';
  if (delta < -5) {
    message = `↓ $${Math.abs(Math.round(delta))} cheaper than last check`;
  } else if (delta > 5) {
    message = `↑ $${Math.round(delta)} more than last check`;
  } else {
    message = '→ Price stable since last check';
  }

  if (isAtLow && allPrices.length >= 3) message += ' — AT ALL-TIME LOW! Buy now!';
  else if (longTrend === 'falling') message += ' — prices trending down';
  else if (longTrend === 'rising') message += ' — prices trending up, consider booking soon';

  return {
    delta: Math.round(delta),
    direction: delta < -5 ? 'down' : delta > 5 ? 'up' : 'stable',
    longTrend,
    isAtLow,
    allTimeLow,
    message,
    snapshotCount: route.snapshots.length,
  };
}

/**
 * Get all tracked routes.
 */
function getTrackedRoutes() {
  const data = _load();
  return Object.entries(data).map(([key, route]) => {
    const last = route.snapshots[route.snapshots.length - 1];
    return {
      key,
      origin: route.origin,
      destination: route.destination,
      date: route.date,
      lastPrice: last?.lowestPrice || null,
      lastChecked: last?.timestamp || null,
      snapshotCount: route.snapshots.length,
    };
  });
}

/**
 * Build Google Flights URL for a route (useful for Claude to navigate with Playwright).
 */
function googleFlightsUrl(origin, destination, date, returnDate) {
  // Google Flights URL format
  const params = new URLSearchParams();
  // Direct URL format: https://www.google.com/travel/flights?q=SFO+to+JFK+May+15
  const dateStr = date ? new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const query = `${origin} to ${destination} ${dateStr}`.trim();
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
}

const { searchFlights, formatFlightResults } = require('./google-flights');

/**
 * Search flights and record a snapshot in one call.
 */
async function checkFlightPrices(origin, destination, date, { airline = 'Delta', returnDate } = {}) {
  const result = await searchFlights(origin, destination, date, returnDate, { airline });
  if (!result.error && result.lowestDelta != null) {
    recordSnapshot(origin, destination, date, {
      lowest: result.lowestDelta,
      airline,
      options: (result.flights || []).slice(0, 5).map(f => ({
        price: f.price, airline: f.airline, stops: f.stops, duration: f.totalDuration,
      })),
    });
  }
  const trend = getTrend(origin, destination, date);
  return formatFlightResults(result, { origin, destination, date, airline, trend });
}

/**
 * System prompt instructions for Claude.
 */
const FLIGHT_INSTRUCTIONS = `
**FLIGHT PRICES**: \`[FLIGHT_SEARCH: origin=SFO destination=JFK date=YYYY-MM-DD]\` Optional: airline=Delta, returnDate=YYYY-MM-DD. System searches Google Flights and tracks price trends.
Re-queries show trends ("↓ $15 cheaper", "prices rising"). When user asks about tracked flights, check all routes and report trends.`.trim();

module.exports = {
  recordSnapshot,
  getTrend,
  getTrackedRoutes,
  googleFlightsUrl,
  routeKey,
  checkFlightPrices,
  FLIGHT_INSTRUCTIONS,
};
