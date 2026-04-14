/**
 * concert-price-history.js — Persist price snapshots for trend analysis
 *
 * Every time prices are fetched, a snapshot is saved. Over time this allows:
 *   - "Prices dropped $8 since last check"
 *   - "Prices have been falling for 3 days — good time to buy"
 *   - "Prices rising — buy soon"
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('../../atomic-write');

const HISTORY_FILE = path.join('/app/data', 'concert-price-history.json');
const MAX_SNAPSHOTS_PER_EVENT = 30;

function _load() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {}
  return {};
}

function _save(data) {
  try { atomicWriteJsonSync(HISTORY_FILE, data); } catch (e) {
    console.error(`[concert-history] save failed: ${e.message}`);
  }
}

/**
 * Generate a stable key for an event.
 */
function eventKey(artist, venue, date) {
  const parts = [artist, venue, date].map(s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  return parts.filter(Boolean).join('_');
}

/**
 * Record a price snapshot for an event.
 * @param {object} opts - { artist, venue, date, city }
 * @param {object} pricesBySource - { stubhub: { min, max, listings, url }, ... }
 */
function recordSnapshot(opts, pricesBySource) {
  const key = eventKey(opts.artist, opts.venue, opts.date);
  if (!key) return;

  const data = _load();
  if (!data[key]) {
    data[key] = {
      artist: opts.artist || '',
      venue: opts.venue || '',
      date: opts.date || '',
      city: opts.city || '',
      snapshots: [],
    };
  }

  const snapshot = { timestamp: new Date().toISOString(), min: {}, avg: {} };
  for (const [site, result] of Object.entries(pricesBySource)) {
    if (!result) continue;
    if (result.min != null) snapshot.min[site] = result.min;
    if (result.listings && result.listings.length > 0) {
      const prices = result.listings.map(l => l.price).filter(p => p != null);
      if (prices.length > 0) {
        snapshot.avg[site] = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
      }
    }
  }

  data[key].snapshots.push(snapshot);
  // Trim to max
  while (data[key].snapshots.length > MAX_SNAPSHOTS_PER_EVENT) {
    data[key].snapshots.shift();
  }

  _save(data);
}

/**
 * Get trend info for an event.
 * @returns {object|null} { direction, minDelta, message }
 */
function getTrend(artist, venue, date) {
  const key = eventKey(artist, venue, date);
  const data = _load();
  const event = data[key];
  if (!event || event.snapshots.length < 2) return null;

  const latest = event.snapshots[event.snapshots.length - 1];
  const previous = event.snapshots[event.snapshots.length - 2];

  // Compare overall minimum across all sites
  const latestMin = Math.min(...Object.values(latest.min).filter(v => v != null));
  const previousMin = Math.min(...Object.values(previous.min).filter(v => v != null));

  if (!isFinite(latestMin) || !isFinite(previousMin)) return null;

  const delta = latestMin - previousMin;
  const direction = delta < -2 ? 'down' : delta > 2 ? 'up' : 'stable';

  // Look at longer trend (last 5 snapshots)
  let longTrend = 'stable';
  if (event.snapshots.length >= 3) {
    const recent5 = event.snapshots.slice(-5);
    const mins = recent5.map(s => Math.min(...Object.values(s.min).filter(v => v != null))).filter(isFinite);
    if (mins.length >= 3) {
      const first = mins[0];
      const last = mins[mins.length - 1];
      const totalDelta = last - first;
      if (totalDelta < -5) longTrend = 'falling';
      else if (totalDelta > 5) longTrend = 'rising';
    }
  }

  let message = '';
  if (direction === 'down') {
    message = `↓ $${Math.abs(Math.round(delta))} cheaper than last check`;
  } else if (direction === 'up') {
    message = `↑ $${Math.round(delta)} more than last check`;
  } else {
    message = '→ Prices stable since last check';
  }

  if (longTrend === 'falling') {
    message += ' — prices have been dropping, good time to buy';
  } else if (longTrend === 'rising') {
    message += ' — prices trending up, consider buying soon';
  }

  return { direction, delta: Math.round(delta), longTrend, message };
}

/**
 * Get all tracked events (for listing).
 */
function getTrackedEvents() {
  const data = _load();
  return Object.entries(data).map(([key, event]) => ({
    key,
    artist: event.artist,
    venue: event.venue,
    date: event.date,
    snapshotCount: event.snapshots.length,
    lastChecked: event.snapshots.length > 0 ? event.snapshots[event.snapshots.length - 1].timestamp : null,
  }));
}

module.exports = { recordSnapshot, getTrend, getTrackedEvents, eventKey };
