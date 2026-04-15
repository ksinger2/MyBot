/**
 * find-shows.js — Deterministic upcoming-shows lookup.
 *
 * Single source of truth for "given an artist (or list of artists) and a
 * location, what real upcoming shows exist on Ticketmaster?" Used by both
 * the !concerts command (interactive) and the scheduler (concert-tracker
 * cron jobs). No prompting, no Claude — pure data in, pure data out.
 *
 * This file is the deterministic infrastructure that replaces
 * "ask Claude to check for upcoming concerts." Per CLAUDE.md's
 * Determinism Rule: prompt language is not a reliability mechanism.
 */

const { geocode: weatherGeocode } = require('../weather');

const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY || '';
const TM_BASE = 'https://app.ticketmaster.com/discovery/v2';

const DEFAULT_RADIUS_MILES = 50;
const DEFAULT_PER_ARTIST_LIMIT = 5;
const DEFAULT_CONCURRENCY = 5; // TM free tier is ~5 req/sec
const DEFAULT_PER_ARTIST_TIMEOUT_MS = 8000;
const DEFAULT_LOOK_AHEAD_MONTHS = 3;
const MAX_UNCURATED_FANOUT = 100; // protects TM 5k/day quota

// Process-lifetime geocode cache. Keyed by the raw location string so
// "Boston, MA" and "Boston MA" share the same cached entry across all
// callers (CLI command + scheduled jobs).
const _geocodeCache = new Map();

async function resolveLocation(rawLocation) {
  if (!rawLocation) return null;
  if (_geocodeCache.has(rawLocation)) return _geocodeCache.get(rawLocation);
  try {
    const hit = await weatherGeocode(rawLocation);
    if (hit && typeof hit.lat === 'number' && typeof hit.lon === 'number') {
      _geocodeCache.set(rawLocation, hit);
      return hit;
    }
  } catch (e) {
    console.warn(`[find-shows] geocode "${rawLocation}" failed: ${e.message}`);
  }
  _geocodeCache.set(rawLocation, null);
  return null;
}

/**
 * Derive a city name from a free-form location string. Used as the
 * Ticketmaster `city=` fallback when geocoding fails.
 */
function deriveCity(locationStr) {
  if (!locationStr || typeof locationStr !== 'string') return '';
  const parts = locationStr.split(/[,\s]+/).filter(Boolean);
  return parts[0] || '';
}

/**
 * Single Ticketmaster keyword search for one artist near coords/city.
 * Returns the raw `_embedded.events` array (possibly empty), or `null`
 * if the API key is missing or the request errored out.
 */
async function searchTicketmaster(artist, coords, city, opts = {}) {
  if (!TICKETMASTER_API_KEY) return null;
  const radiusMiles = opts.radiusMiles ?? DEFAULT_RADIUS_MILES;
  const perArtistLimit = opts.perArtistLimit ?? DEFAULT_PER_ARTIST_LIMIT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PER_ARTIST_TIMEOUT_MS;
  const lookAheadMonths = opts.lookAheadMonths ?? DEFAULT_LOOK_AHEAD_MONTHS;

  const params = new URLSearchParams({
    apikey: TICKETMASTER_API_KEY,
    keyword: artist,
    size: String(perArtistLimit),
    classificationName: 'music',
    sort: 'date,asc',
  });

  // Time bounds: only events from now through `lookAheadMonths` months
  // out. Without this TM happily returns shows 2 years away, which the
  // user will never act on and which inflates the "no shows" count.
  const now = new Date();
  const end = new Date(now.getTime());
  end.setUTCMonth(end.getUTCMonth() + lookAheadMonths);
  params.set('startDateTime', `${now.toISOString().slice(0, 19)}Z`);
  params.set('endDateTime', `${end.toISOString().slice(0, 19)}Z`);

  if (coords) {
    // latlong+radius is the proximity-search path. Catches venues that
    // TM labels with neighbor city names (Berkeley/Oakland count as
    // "near Alameda", Cambridge/Brookline count as "near Boston").
    params.set('latlong', `${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`);
    params.set('radius', String(radiusMiles));
    params.set('unit', 'miles');
  } else if (city) {
    params.set('city', city);
  }

  try {
    const res = await fetch(`${TM_BASE}/events.json?${params}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data._embedded?.events || [];
  } catch {
    return null;
  }
}

/**
 * Normalize a TM event into the shape the rest of the codebase uses.
 * Includes a stable `id` (TM event id, falling back to name+date) for
 * dedup across multiple per-artist queries that return the same show.
 */
function formatEvent(event, artistHint = null) {
  const name = event.name || artistHint || 'Unknown';
  const venue = event._embedded?.venues?.[0];
  const venueId = venue?.id || '';
  const venueName = venue?.name || 'Unknown venue';
  const city = venue?.city?.name || '';
  const state = venue?.state?.stateCode || '';
  const loc = [city, state].filter(Boolean).join(', ');
  const date = event.dates?.start?.localDate || 'TBD';
  const time = event.dates?.start?.localTime ? ` ${event.dates.start.localTime.slice(0, 5)}` : '';

  // TM Discovery returns priceRanges as `[{type, currency, min, max}]`.
  // Extract the lowest min and highest max across all ranges so the
  // scheduler can do threshold comparison without firing scrapers.
  // Note: TM prices are face-value primary-market; they don't include
  // service fees and don't reflect resale market lows.
  let priceMin = null;
  let priceMax = null;
  let priceCurrency = null;
  for (const range of (event.priceRanges || [])) {
    if (range.min != null && (priceMin == null || range.min < priceMin)) priceMin = range.min;
    if (range.max != null && (priceMax == null || range.max > priceMax)) priceMax = range.max;
    if (!priceCurrency && range.currency) priceCurrency = range.currency;
  }

  return {
    name,
    venueName,
    venueId,
    venueCity: city,
    venueState: state,
    loc,
    date,
    time,
    url: event.url || null,
    id: event.id || `${name}-${date}`,
    // Composite dedup key — same date + same venue NAME = same show.
    // We can't use venueId because TM exposes a different venue id
    // for the "Platinum Tickets" / VIP-bundle versions of the same
    // show (e.g. Tim McGraw at Fenway has venue id KovZpZAaaI7A for
    // regular tix and Z6r9jZkkee for the Platinum bundle, even though
    // both are physically Fenway Park). Normalize the name to ignore
    // case/whitespace differences before keying.
    showKey: `${date}|${(venueName || '').toLowerCase().trim()}`,
    priceMin,
    priceMax,
    priceCurrency,
  };
}

// ── Strict artist matching ────────────────────────────────────────────────
// TM keyword search is loose — searching "Prince" returns "Prince Royce",
// "Prince Daddy & the Hyena", tribute bands, etc. The dead-artist
// hallucination bug surfaced here: searches for dead artists returned
// shows for live artists with substring matches in their names.
//
// Defense: require an exact (case/whitespace-normalized) match in the
// event's `attractions` array. TM populates this with the actual artist
// objects on the bill — Romeo Santos & Prince Royce returns
// `attractions: [Romeo Santos, Prince Royce]`, neither of which equals
// "Prince" exactly.
//
// If `attractions` is empty (rare — unkeyed local events), DROP the
// event rather than fall back to fuzzy matching. We'd rather miss a
// valid show than fabricate one.

function _normalizeName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^\p{Letter}\p{Number}\s]/gu, '')         // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function _eventMatchesArtist(event, queryArtist) {
  const target = _normalizeName(queryArtist);
  if (!target) return false;
  const attractions = event._embedded?.attractions || [];
  if (attractions.length === 0) return false;
  for (const a of attractions) {
    if (_normalizeName(a.name) === target) return true;
  }
  return false;
}

async function _runInBatches(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

/**
 * THE DETERMINISTIC ENTRY POINT.
 *
 * Given a list of artists + a location, returns the real upcoming shows
 * Ticketmaster knows about, deduped, sorted by date, grouped by artist.
 * No prompting, no LLM, no fabrication possible. Dead artists return
 * zero shows — TM has no future events for them, and they fall into the
 * `noShowArtists` bucket automatically.
 *
 * @param {object} opts
 * @param {string[]} opts.artists - artist names
 * @param {string} opts.location - free-form location (e.g. "Boston, MA")
 * @param {number} [opts.radiusMiles=50]
 * @param {number} [opts.perArtistLimit=5]
 * @param {number} [opts.lookAheadMonths=3]
 * @param {number} [opts.concurrency=5]
 * @param {boolean} [opts.cap=true] - if true and >MAX_UNCURATED_FANOUT artists, truncate
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   location: string,
 *   coords: {lat:number,lon:number}|null,
 *   city: string,
 *   radiusMiles: number,
 *   lookAheadMonths: number,
 *   searchedArtists: string[],
 *   capped: boolean,
 *   originalArtistCount: number,
 *   shows: Array,
 *   byArtist: Map<string, Array>,
 *   withShowsCount: number,
 *   noShowArtists: string[],
 *   tmAvailable: boolean,
 * }>}
 */
async function findUpcomingShows(opts) {
  const {
    artists = [],
    location = '',
    radiusMiles = DEFAULT_RADIUS_MILES,
    perArtistLimit = DEFAULT_PER_ARTIST_LIMIT,
    lookAheadMonths = DEFAULT_LOOK_AHEAD_MONTHS,
    concurrency = DEFAULT_CONCURRENCY,
    cap = true,
  } = opts || {};

  const baseShape = {
    location,
    coords: null,
    city: deriveCity(location),
    radiusMiles,
    lookAheadMonths,
    searchedArtists: [],
    capped: false,
    originalArtistCount: artists.length,
    shows: [],
    byArtist: new Map(),
    withShowsCount: 0,
    noShowArtists: [],
    tmAvailable: !!TICKETMASTER_API_KEY,
  };

  if (!TICKETMASTER_API_KEY) {
    return { ...baseShape, ok: false, reason: 'no-ticketmaster-key' };
  }
  if (!Array.isArray(artists) || artists.length === 0) {
    return { ...baseShape, ok: false, reason: 'no-artists' };
  }
  if (!location) {
    return { ...baseShape, ok: false, reason: 'no-location' };
  }

  // Cap to protect the TM free tier from accidental blowups.
  let working = artists;
  let capped = false;
  if (cap && artists.length > MAX_UNCURATED_FANOUT) {
    working = artists.slice(0, MAX_UNCURATED_FANOUT);
    capped = true;
  }

  const coords = await resolveLocation(location);
  const city = deriveCity(location);

  // Per-artist TM query. We over-fetch (3x perArtistLimit) because the
  // strict attraction-match filter below will drop substring false
  // positives like "Prince Royce" from a "Prince" query — without
  // over-fetching, we'd often hit the cap with garbage and have no
  // real matches left.
  const rawResults = await _runInBatches(working, concurrency, async (artist) => {
    const events = await searchTicketmaster(artist, coords, city, {
      radiusMiles,
      perArtistLimit: Math.max(perArtistLimit * 3, 15),
      lookAheadMonths,
    });
    if (!events) return { artist, events: [] };

    // STRICT FILTER — only keep events where one of TM's attraction
    // entries equals the queried artist exactly (case/whitespace/
    // diacritic normalized). Drops "Prince Royce" when querying for
    // dead-Prince. Drops events with no attractions list at all.
    const filtered = events.filter(e => _eventMatchesArtist(e, artist));
    return { artist, events: filtered.slice(0, perArtistLimit) };
  });

  // Flatten + dedupe by composite show key (date|venueId), so a single
  // show that TM exposes as N separate ticket-tier event IDs collapses
  // to one entry. The queryArtist is preserved on the deduped row.
  const shows = [];
  const seen = new Set();
  for (const { artist, events } of rawResults) {
    for (const event of events) {
      const formatted = formatEvent(event, artist);
      if (seen.has(formatted.showKey)) continue;
      seen.add(formatted.showKey);
      shows.push({ ...formatted, queryArtist: artist });
    }
  }

  shows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const byArtist = new Map();
  for (const show of shows) {
    const key = show.queryArtist;
    if (!byArtist.has(key)) byArtist.set(key, []);
    byArtist.get(key).push(show);
  }

  const withShows = new Set([...byArtist.keys()]);
  const noShowArtists = working.filter(a => !withShows.has(a));

  return {
    ok: true,
    location,
    coords,
    city,
    radiusMiles,
    lookAheadMonths,
    searchedArtists: working,
    capped,
    originalArtistCount: artists.length,
    shows,
    byArtist,
    withShowsCount: byArtist.size,
    noShowArtists,
    tmAvailable: true,
  };
}

module.exports = {
  findUpcomingShows,
  searchTicketmaster,
  resolveLocation,
  deriveCity,
  formatEvent,
  // constants exposed for callers that want to display them
  DEFAULT_RADIUS_MILES,
  DEFAULT_PER_ARTIST_LIMIT,
  DEFAULT_LOOK_AHEAD_MONTHS,
  MAX_UNCURATED_FANOUT,
};
