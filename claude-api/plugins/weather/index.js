/**
 * weather/index.js — Open-Meteo weather plugin.
 *
 * Why: Bianca's default WebSearch + WebFetch scraping of weather.gov's
 * MapClick HTML was producing wrong temperatures (she was parroting monthly
 * averages from content farms, or misreading NWS HTML fields). Open-Meteo
 * is a free, no-API-key, third-party, reliable source that returns clean
 * structured JSON for up to 16 days. Same pattern as the concert-tracker
 * plugin — deterministic server-side call, Claude can't mess it up.
 *
 * Exports:
 *   getForecast(location, fromDate?, toDate?) — formatted plain-text forecast
 *   WEATHER_INSTRUCTIONS — system-prompt block (curl + [WEATHER:] tag)
 */

const GEOCODE_BASE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';

// WMO weather interpretation codes — map the numeric code to a short label.
// Source: https://open-meteo.com/en/docs → WMO Weather interpretation codes.
const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'icy fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'heavy showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm w/ hail', 99: 'thunderstorm w/ hail',
};

function _codeToDesc(code) {
  if (code == null) return 'unknown';
  return WMO[code] || `code ${code}`;
}

async function _fetchJson(url, timeoutMs = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url.split('?')[0]} HTTP ${res.status}`);
  return res.json();
}

// Map common US state abbreviations to full names for matching against
// Open-Meteo's `admin1` field (which returns full state names).
const US_STATE_ABBR = {
  al:'alabama', ak:'alaska', az:'arizona', ar:'arkansas', ca:'california',
  co:'colorado', ct:'connecticut', de:'delaware', fl:'florida', ga:'georgia',
  hi:'hawaii', id:'idaho', il:'illinois', in:'indiana', ia:'iowa', ks:'kansas',
  ky:'kentucky', la:'louisiana', me:'maine', md:'maryland', ma:'massachusetts',
  mi:'michigan', mn:'minnesota', ms:'mississippi', mo:'missouri', mt:'montana',
  ne:'nebraska', nv:'nevada', nh:'new hampshire', nj:'new jersey', nm:'new mexico',
  ny:'new york', nc:'north carolina', nd:'north dakota', oh:'ohio', ok:'oklahoma',
  or:'oregon', pa:'pennsylvania', ri:'rhode island', sc:'south carolina',
  sd:'south dakota', tn:'tennessee', tx:'texas', ut:'utah', vt:'vermont',
  va:'virginia', wa:'washington', wv:'west virginia', wi:'wisconsin', wy:'wyoming',
  dc:'district of columbia',
};
const US_STATE_NAMES = new Set(Object.values(US_STATE_ABBR));

/**
 * Split a free-form location into { city, stateHint }. Handles:
 *   "Alameda"                → { city: "Alameda", stateHint: null }
 *   "Alameda, CA"            → { city: "Alameda", stateHint: "CA" }
 *   "Alameda California"     → { city: "Alameda", stateHint: "California" }
 *   "Alameda CA"             → { city: "Alameda", stateHint: "CA" }
 *   "San Francisco, CA, USA" → { city: "San Francisco", stateHint: "CA" }
 */
function _splitLocation(raw) {
  const trimmed = raw.trim();
  // Comma form: take first segment as city, second as state
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
    return { city: parts[0], stateHint: parts[1] || null };
  }
  // Space form: check trailing tokens for a state abbreviation or full name
  const lower = trimmed.toLowerCase();
  // Try longest-match against full state names (handles "New York", "North Carolina")
  for (const full of US_STATE_NAMES) {
    if (lower.endsWith(' ' + full)) {
      return { city: trimmed.slice(0, -full.length - 1).trim(), stateHint: full };
    }
  }
  // Try trailing 2-letter abbreviation
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    const last = words[words.length - 1];
    if (/^[A-Za-z]{2}$/.test(last) && US_STATE_ABBR[last.toLowerCase()]) {
      return { city: words.slice(0, -1).join(' '), stateHint: last };
    }
  }
  return { city: trimmed, stateHint: null };
}

/**
 * Geocode a free-form location string to { lat, lon, name, region, tz }.
 * Open-Meteo's geocoder is strict — it only accepts bare city names, not
 * "City, State". This wrapper parses out a state hint, queries the city,
 * asks for up to 5 matches, then filters by state to disambiguate common
 * names (Springfield, Portland, Columbus, etc.).
 *
 * @param {string} location
 * @returns {Promise<{lat:number,lon:number,name:string,region:string,tz:string}|null>}
 */
async function geocode(location) {
  if (!location || typeof location !== 'string') return null;
  const { city, stateHint } = _splitLocation(location);
  const normHint = (stateHint || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Resolve 2-letter abbreviation to full state name if applicable
  const hintFull = US_STATE_ABBR[normHint] || normHint;

  const attempt = async (name) => {
    const params = new URLSearchParams({
      name, count: '5', language: 'en', format: 'json',
    });
    try {
      const data = await _fetchJson(`${GEOCODE_BASE}?${params}`);
      return data?.results || [];
    } catch (e) {
      console.warn(`[weather] geocode(${name}) HTTP: ${e.message}`);
      return [];
    }
  };

  // Try the parsed city first; if nothing comes back, fall back to the raw
  // input (some Open-Meteo results index multi-word names directly).
  let results = await attempt(city);
  if (results.length === 0 && city !== location.trim()) {
    results = await attempt(location.trim());
  }
  if (results.length === 0) return null;

  // Prefer the result whose admin1 (state) matches the hint. Fall back to
  // the first result if there's no hint or no match.
  let best = results[0];
  if (hintFull) {
    const match = results.find(r =>
      (r.admin1 || '').toLowerCase() === hintFull
    );
    if (match) best = match;
  }

  return {
    lat: best.latitude,
    lon: best.longitude,
    name: best.name,
    region: best.admin1 || best.country || '',
    tz: best.timezone || 'auto',
  };
}

/**
 * Get a structured 16-day forecast for a location.
 *
 * @param {string} location — free-form string ("Alameda, CA", "San Francisco")
 * @param {string} [fromDate] — YYYY-MM-DD, default today
 * @param {string} [toDate]   — YYYY-MM-DD, default fromDate + 6 days
 * @returns {Promise<string>} — formatted plain-text forecast ready to send
 */
async function getForecast(location, fromDate, toDate) {
  const place = await geocode(location);
  if (!place) {
    return `Couldn't find "${location}" to look up the weather. Try a more specific name (e.g., "Alameda, CA").`;
  }

  const params = new URLSearchParams({
    latitude: String(place.lat),
    longitude: String(place.lon),
    daily: [
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_probability_max',
      'precipitation_sum',
      'weather_code',
      'wind_speed_10m_max',
      'sunrise',
      'sunset',
    ].join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: place.tz,
    forecast_days: '16',
  });

  let data;
  try {
    data = await _fetchJson(`${FORECAST_BASE}?${params}`);
  } catch (e) {
    return `Weather lookup failed: ${e.message}. Try again in a minute.`;
  }

  const daily = data?.daily;
  if (!daily || !Array.isArray(daily.time) || daily.time.length === 0) {
    return `Weather API returned no data for ${place.name}.`;
  }

  // Filter by date range if provided; default = next 7 days from today.
  const from = fromDate || daily.time[0];
  const to = toDate || _addDays(from, 6);
  const lines = [];
  for (let i = 0; i < daily.time.length; i++) {
    const d = daily.time[i];
    if (d < from || d > to) continue;
    const hi = Math.round(daily.temperature_2m_max[i]);
    const lo = Math.round(daily.temperature_2m_min[i]);
    const pop = daily.precipitation_probability_max[i];
    const precip = daily.precipitation_sum[i];
    const code = daily.weather_code[i];
    const wind = Math.round(daily.wind_speed_10m_max[i]);
    const desc = _codeToDesc(code);
    const dayName = new Date(d + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric', timeZone: place.tz,
    });
    const popPart = (pop != null && pop > 0) ? ` · ${pop}% precip` : '';
    const precipPart = (precip != null && precip > 0.05) ? ` (${precip.toFixed(2)}")` : '';
    const windPart = wind > 15 ? ` · wind ${wind} mph` : '';
    lines.push(`• ${dayName}: ${hi}°/${lo}° ${desc}${popPart}${precipPart}${windPart}`);
  }

  if (lines.length === 0) {
    return `No forecast data for ${place.name} between ${from} and ${to} (Open-Meteo covers today + 15 days).`;
  }

  const header = `Weather for ${place.name}${place.region ? ', ' + place.region : ''} — source: Open-Meteo`;
  return [header, ...lines].join('\n');
}

function _addDays(yyyymmdd, n) {
  const d = new Date(yyyymmdd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── System prompt instructions ────────────────────────────────────────────────

const WEATHER_INSTRUCTIONS = `
**WEATHER**: When the user asks about weather, temperature, forecast, "should I go to X outside", "will it rain", etc., use the weather plugin instead of WebSearch/WebFetch. WebSearch returns stale monthly averages from content farms; the plugin hits Open-Meteo (official, no API key, 16-day forecast) and returns real structured data.

**DM / with Bash**: call
\`\`\`
curl -s -X POST http://localhost:3400/weather \\
  -H "Content-Type: application/json" \\
  -H "X-Internal-Token: $INTERNAL_API_TOKEN" \\
  -d '{"location":"Alameda CA","fromDate":"2026-04-18","toDate":"2026-04-19"}'
\`\`\`

Parameters:
- \`location\` — required, free-form string (use the user's profile location by default)
- \`fromDate\` — optional YYYY-MM-DD, defaults to today
- \`toDate\` — optional YYYY-MM-DD, defaults to \`fromDate\` + 6 days

Response is \`{ text: "formatted forecast" }\` — relay the \`text\` field directly. Always use THIS data, not cached/remembered numbers.

**Group chats (no Bash)**: use the tag instead. The system will call the plugin and append the results to your response:
\`[WEATHER: location="Alameda CA" fromDate="2026-04-18" toDate="2026-04-19"]\`

Or shorthand with just a location:
\`[WEATHER: Alameda CA]\`

When the user asks about weather for "this weekend", "next weekend", "tomorrow", "this week" — resolve the date range yourself using the current date injected above, then pass absolute \`fromDate\`/\`toDate\` values to the plugin. Never pass relative dates — Open-Meteo only understands YYYY-MM-DD.`.trim();

module.exports = { geocode, getForecast, WEATHER_INSTRUCTIONS };
