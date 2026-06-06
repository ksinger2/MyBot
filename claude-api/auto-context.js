/**
 * auto-context.js — Deterministic data pre-fetching for user messages.
 *
 * PROBLEM: When a user asks "what do I have tomorrow?", the bot relies on
 * Claude choosing to emit [CALENDAR:] — which is non-deterministic. Claude
 * sometimes answers from training data, formats the tag wrong, or skips it.
 *
 * SOLUTION: Detect intent server-side BEFORE Claude sees the message,
 * pre-fetch the data (calendar, weather), and inject it into the prompt.
 * Claude just formats what's already in front of it — no tag needed.
 *
 * This follows the Determinism Rule: data is injected by infrastructure,
 * not by Claude's choice to emit a tag.
 */

const { getInternalToken } = require('./internal-token');
const { getProfile } = require('./user-profiles');

// ── Intent detection regexes ────────────────────────────────────────────────

const CALENDAR_INTENT = /\b(schedul|calendar|plans?|planned|free|busy|avail|appoint|meeting|event|tomorrow|tonight|this week|next week|today|this (saturday|sunday|monday|tuesday|wednesday|thursday|friday)|what('s| is| do i have| am i doing| are (we|you) doing) (on|happening|planned|doing)|am i free|do i have (any|some)thing|what('s| is) (on )?my|clear my|cancel my|move my|reschedule)\b/i;

const WEATHER_INTENT = /\b(weather|forecast|rain|snow|cold|hot|warm|temperature|degrees|sunny|cloudy|storm|wind|humid|outside|umbrella|jacket|coat|should i wear|what('s| is) it (like|gonna be)|how('s| is) (the weather|it outside)|will it)\b/i;

// ── Action intent detection — injects hints so Claude reliably emits the right tag ──
// These don't pre-fetch data (you can't pre-generate an image), but they inject
// a system hint that makes tag emission near-certain instead of hoping Claude remembers.

const IMAGINE_INTENT = /\b(draw|sketch|paint|illustrate|generate|create|make|design)\s+(me\s+)?(a |an |the |some )?(picture|image|photo|illustration|drawing|sketch|art|portrait|poster|meme|diagram|logo|icon|graphic|render|visual|avatar|selfie)\b|\b(draw|sketch|paint|illustrate)\s+(me|us)\b|\b(imagine|visualize|depict|show me)\b.*\b(image|picture|drawing|visual|what .* looks like)\b|\b(picture of|image of|photo of|drawing of|illustration of)\b/i;

const REMIND_INTENT = /\b(remind|reminder|alert)\s+(me|us)\b|\bdon'?t (let me )?forget\b|\bset (a |an )?(reminder|alarm|timer)\b|\bremind .* (at|in|on|tomorrow|tonight|later|morning|evening|afternoon)\b/i;

const EVENT_INTENT = /\b(schedule|create|add|set up|make|put)\s+(a |an )?(event|appointment|meeting|hangout|dinner|lunch|brunch|party|gathering)\b|\b(schedule|create|add)\s+(something|this|that|it)\s+(on|for|at)\b/i;

const EIGHTSLEEP_INTENT = /\b(bed|eight\s*sleep|eightsleep|mattress|pod|side)\b.*\b(on|off|warm|cool|cold|hot|temperature|temp|status|level|set|turn|switch)\b|\b(turn|switch)\s+(on|off|up|down)\s+(my\s+|the\s+)?(bed|mattress|pod|side)\b|\bhow\s+(warm|cool|cold|hot)\s+is\s+(my\s+)?(bed|mattress|side|pod)\b|\bhow('s| is) (my )?(bed|mattress|side|pod)\b|\bmake\s+(my\s+)?(bed|side|pod)\s+(warm|cool|cold|hot|cooler|warmer)\b/i;

const CONCERT_PRICE_INTENT = /\b(ticket|tickets|prices?|pricing|how much|cost|cheapest|best deal|best price|stub\s*hub|vivid\s*seats|tick\s*pick|seat\s*geek|ticketmaster|resale|face value|nosebleed|pit|floor seats?|ga tickets?|general admission)\b.*\b(concert|show|tour|festival|gig|perform|event|arena|stadium|venue|live)\b|\b(concert|show|tour|festival|gig|perform|event|arena|stadium|venue|live)\b.*\b(ticket|tickets|prices?|pricing|how much|cost|cheapest|best deal|best price)\b|\b(find|get|check|compare|look up|search|scrape)\b.*\b(ticket|tickets|prices?)\b|\btickets?\s+(for|to)\b|\bprices?\s+(for|to)\b|\bhow much\b.*\btickets?\b|\bticket\s+prices?\b/i;

// Date range extraction from natural language
function _extractDateRange(text, timezone = 'America/Los_Angeles') {
  const now = new Date();
  const today = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const todayStr = _fmt(today);

  const lower = text.toLowerCase();

  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return { from: _fmt(d), to: _fmt(d) };
  }
  if (/\btonight\b/.test(lower) || /\btoday\b/.test(lower) || /\bright now\b/.test(lower)) {
    return { from: todayStr, to: todayStr };
  }
  if (/\bthis week(end)?\b/.test(lower)) {
    const end = new Date(today);
    // Sunday = end of week
    end.setDate(end.getDate() + (7 - end.getDay()));
    return { from: todayStr, to: _fmt(end) };
  }
  if (/\bnext week\b/.test(lower)) {
    const start = new Date(today);
    start.setDate(start.getDate() + (8 - start.getDay()));
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { from: _fmt(start), to: _fmt(end) };
  }

  // Day names: "on Monday", "this Friday", etc.
  const dayMatch = lower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (dayMatch) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = days.indexOf(dayMatch[1]);
    const currentDay = today.getDay();
    let diff = targetDay - currentDay;
    if (diff <= 0) diff += 7;
    const target = new Date(today);
    target.setDate(target.getDate() + diff);
    return { from: _fmt(target), to: _fmt(target) };
  }

  // Specific dates: "May 5", "April 30th", "5/1"
  const monthDayMatch = lower.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (monthDayMatch) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mon = months[monthDayMatch[1].slice(0, 3)];
    const day = parseInt(monthDayMatch[2], 10);
    const d = new Date(today.getFullYear(), mon, day);
    if (d < today) d.setFullYear(d.getFullYear() + 1);
    return { from: _fmt(d), to: _fmt(d) };
  }

  // Default: today + 2 days (covers "what do I have planned?")
  const defaultEnd = new Date(today);
  defaultEnd.setDate(defaultEnd.getDate() + 2);
  return { from: todayStr, to: _fmt(defaultEnd) };
}

function _fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _resolveRemindDatetime(text, timezone) {
  const lower = text.toLowerCase();

  // Extract time: "at 2pm", "at 3:30pm", "at 14:00", "at noon"
  let hours = null, minutes = 0;
  const timeMatch = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2] || '0', 10);
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
  } else if (/\bnoon\b/.test(lower)) {
    hours = 12;
  } else if (/\bmidnight\b/.test(lower)) {
    hours = 0;
  }

  if (hours === null) hours = 10; // default to 10am when no time specified

  const dateRange = _extractDateRange(text, timezone);
  const dateStr = dateRange.from;

  // Build a date in the target timezone
  const [y, m, d] = dateStr.split('-').map(Number);
  // Format as IANA timezone offset
  const fakeDate = new Date(y, m - 1, d, hours, minutes, 0);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'longOffset',
  });
  // Get the UTC offset for this date/time in the target timezone
  const parts = formatter.formatToParts(fakeDate);
  const tzOffset = parts.find(p => p.type === 'timeZoneName')?.value || '';
  // Convert "GMT-07:00" → "-07:00"
  const offset = tzOffset.replace('GMT', '') || '+00:00';

  return `${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00${offset}`;
}

// ── Concert artist extraction ──────────────────────────────────────────────
// Extracts artist/event names from user messages. Handles:
//   "tickets for Beyoncé at SoFi"  → ["Beyoncé"]
//   "how much are Drake tickets?"  → ["Drake"]
//   "prices for Sabrina Carpenter in NYC" → ["Sabrina Carpenter"]
//   "find tickets for Beyoncé, Drake, and Billie Eilish" → all three
//   "check prices: Beyoncé June 15, Drake July 4" → both

const _NOISE_WORDS = new Set([
  'tickets', 'ticket', 'prices', 'price', 'pricing', 'concert', 'concerts',
  'show', 'shows', 'tour', 'tours', 'event', 'events', 'find', 'get', 'check',
  'compare', 'look', 'search', 'scrape', 'how', 'much', 'cost', 'cheapest',
  'best', 'deal', 'the', 'a', 'an', 'for', 'to', 'at', 'in', 'on', 'and',
  'me', 'my', 'some', 'any', 'please', 'can', 'you', 'i', 'want', 'need',
  'up', 'of', 'are', 'is', 'it', 'do', 'what', 'these', 'those', 'this',
  'that', 'with', 'from', 'or', 'but', 'also', 'too', 'just',
]);

function _extractArtists(text) {
  const artists = [];
  const cleaned = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[[\](){}]/g, '')
    .trim();

  // Pattern 1: "tickets/prices for X", "tickets to X"
  const forPattern = /(?:tickets?|prices?|pricing)\s+(?:for|to)\s+(.+?)(?:\s+(?:at|in|on|near|@)\s+|[,;]|\s*$)/gi;
  let m;
  while ((m = forPattern.exec(cleaned)) !== null) {
    const raw = m[1].trim().replace(/\s+(tickets?|prices?|concert|show|tour)$/i, '');
    if (raw.length >= 2 && raw.length <= 80) artists.push(raw);
  }

  // Pattern 2: "X tickets", "X concert", "X show", "X tour"
  const suffixPattern = /\b([A-Z][A-Za-zÀ-ÖØ-öø-ÿ''.\-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ''.\-]+){0,4})\s+(?:tickets?|concert|show|tour)\b/g;
  while ((m = suffixPattern.exec(cleaned)) !== null) {
    const raw = m[1].trim();
    if (raw.length >= 2 && !_NOISE_WORDS.has(raw.toLowerCase())) artists.push(raw);
  }

  // Pattern 3: comma/newline-separated list after a header phrase
  const listPattern = /(?:prices?|tickets?|events?|shows?)\s*(?:for|:)\s*(.+)/is;
  const listMatch = cleaned.match(listPattern);
  if (listMatch) {
    const items = listMatch[1].split(/[,;\n]+/).map(s => s.trim());
    for (const item of items) {
      const stripped = item
        .replace(/\b(?:at|in|on|@)\s+.+$/i, '')
        .replace(/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/g, '')
        .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (stripped.length >= 2 && stripped.length <= 80 && !_NOISE_WORDS.has(stripped.toLowerCase())) {
        artists.push(stripped);
      }
    }
  }

  // Split on " and " / " & " conjunctions, then clean up
  const expanded = [];
  for (const a of artists) {
    const parts2 = a.split(/\s+(?:and|&)\s+/i);
    for (const p of parts2) {
      const clean = p
        .replace(/^(the|a|an)\s+/i, '')
        .replace(/\s+(tickets?|prices?|concert|show|tour|live|events?)$/i, '')
        .trim();
      if (clean.length >= 2) {
        const words = clean.toLowerCase().split(/\s+/);
        if (!words.every(w => _NOISE_WORDS.has(w))) expanded.push(clean);
      }
    }
  }

  // Deduplicate (case-insensitive)
  const seen = new Set();
  return expanded.filter(a => {
    const key = a.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

// ── Data fetchers ───────────────────────────────────────────────────────────

async function _fetchCalendar(userId, dateRange, isGroupChat, timezone) {
  const token = getInternalToken();
  if (!token) return null;

  try {
    const payload = JSON.stringify({
      userId,
      fromDate: dateRange.from,
      toDate: dateRange.to,
      isGroupChat: !!isGroupChat,
      timezone: timezone || undefined,
    });

    const http = require('http');
    return new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: 3400,
        path: '/calendar/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Internal-Token': token,
        },
        timeout: 8000,
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.connected === false) {
              resolve(null);
              return;
            }
            resolve(data);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    });
  } catch {
    return null;
  }
}

async function _fetchWeather(location) {
  try {
    const weatherPlugin = require('./plugins/weather');
    const result = await weatherPlugin.getForecast(location);
    return result;
  } catch (err) {
    console.warn(`[auto-context] weather fetch failed: ${err.message}`);
    return null;
  }
}

async function _fetchConcertPrices(artists, text) {
  try {
    const { isAvailable, getPrices } = require('./plugins/concert-tracker');
    if (!(await isAvailable())) {
      console.warn('[auto-context] concert scraper not available');
      return null;
    }

    // Extract venue/city/date hints from the full message
    const venueMatch = text.match(/\b(?:at|@)\s+([A-Z][A-Za-z\s'.\-]+(?:Stadium|Arena|Center|Centre|Garden|Theater|Theatre|Hall|Park|Amphitheater|Bowl|Pavilion|Forum|Coliseum))/i);
    const cityMatch = text.match(/\b(?:in|near)\s+([A-Z][A-Za-z\s]+?)(?:\s*[,;.]|\s+(?:on|for|tickets?|prices?|and)\b|$)/i);
    const dateRange = _extractDateRange(text);
    const venue = venueMatch ? venueMatch[1].trim() : '';
    const city = cityMatch ? cityMatch[1].trim() : '';

    const results = await Promise.all(
      artists.map(async (artist) => {
        try {
          const priceText = await getPrices(artist, venue, dateRange.from !== _fmt(new Date()) ? dateRange.from : '', city);
          return { artist, text: priceText };
        } catch (e) {
          console.warn(`[auto-context] concert price fetch failed for "${artist}": ${e.message}`);
          return null;
        }
      })
    );

    return results.filter(Boolean);
  } catch (e) {
    console.warn(`[auto-context] concert price module error: ${e.message}`);
    return null;
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Detect data intent in a user message and pre-fetch relevant data.
 * Returns a string to prepend to the prompt, or '' if no data was fetched.
 *
 * @param {string} text — the user's message
 * @param {string} senderId — Signal phone number or Discord ID
 * @param {boolean} isGroupChat
 * @returns {Promise<string>} — context to inject before the user's message
 */
async function enrichWithContext(text, senderId, isGroupChat) {
  if (!text || text.length < 3) return '';

  const profile = getProfile(senderId);
  const parts = [];

  const _tz = profile?.timezone || 'America/Los_Angeles';

  // Calendar auto-fetch
  if (CALENDAR_INTENT.test(text)) {
    if (profile && profile.gcal_connected) {
      const dateRange = _extractDateRange(text, _tz);
      const calData = await _fetchCalendar(senderId, dateRange, isGroupChat, _tz);
      if (calData && calData.text) {
        parts.push(`<calendar-data source="auto-fetched" range="${dateRange.from} to ${dateRange.to}">\n${calData.text}\n</calendar-data>`);
        console.log(`[auto-context] Calendar pre-fetched for ${senderId.slice(0, 4)}****: ${dateRange.from}→${dateRange.to}, ${calData.count || 0} events`);
      }
    }
  }

  // Weather auto-fetch
  if (WEATHER_INTENT.test(text)) {
    const location = profile?.location;
    if (location) {
      const forecast = await _fetchWeather(location);
      if (forecast) {
        parts.push(`<weather-data source="auto-fetched" location="${location}">\n${forecast}\n</weather-data>`);
        console.log(`[auto-context] Weather pre-fetched for ${location}`);
      }
    }
  }

  // Concert price pre-fetch — call the scraper deterministically
  if (CONCERT_PRICE_INTENT.test(text)) {
    const artists = _extractArtists(text);
    if (artists.length > 0) {
      console.log(`[auto-context] Concert price intent detected, artists: ${artists.join(', ')}`);
      const priceResults = await _fetchConcertPrices(artists, text);
      if (priceResults && priceResults.length > 0) {
        for (const r of priceResults) {
          parts.push(`<concert-price-data source="auto-fetched" artist="${r.artist}">\n${r.text}\n</concert-price-data>`);
        }
        console.log(`[auto-context] Concert prices pre-fetched for ${priceResults.length} artist(s)`);
      }
    } else {
      parts.push(`<system-hint type="concert-prices">The user is asking about concert/event ticket prices. You MUST emit a [CONCERT_PRICES: artist="Name" venue="Venue" date="YYYY-MM-DD" city="City"] tag for each event. Only artist is required.</system-hint>`);
      console.log(`[auto-context] Concert price intent detected but no artist extracted — injecting hint`);
    }
  }

  // ── Action intent hints — nudge Claude to emit the correct tag ──
  // These are injected as system context so Claude doesn't have to "remember"
  // the tag syntax from the system prompt. The hint makes tag emission near-certain.

  if (IMAGINE_INTENT.test(text)) {
    parts.push(`<system-hint type="image-generation">The user wants an image generated. You MUST emit an [IMAGINE: detailed description] tag. Do NOT describe what you would draw — emit the tag so the image is actually created.</system-hint>`);
    console.log(`[auto-context] IMAGINE intent detected`);
  }

  if (REMIND_INTENT.test(text)) {
    const resolvedDt = _resolveRemindDatetime(text, _tz);
    const dtHint = resolvedDt
      ? ` The resolved datetime is: ${resolvedDt}. Use this EXACT value for the datetime field — do NOT recalculate.`
      : ` Use timezone ${_tz}.`;
    // If multiple people mentioned ("both me and Karen", "for us", etc.), emit one REMIND tag per person.
    const multiHint = /\b(both|all|us|everyone|me and|and me)\b/i.test(text)
      ? ' The user wants reminders for MULTIPLE people. Emit one [REMIND:] tag per person, each with a different user_ids value.'
      : '';
    parts.push(`<system-hint type="reminder">The user wants a reminder set. You MUST emit a [REMIND: title="what" datetime="ISO 8601" duration_minutes=15] tag in your TEXT RESPONSE.${dtHint}${multiHint} Do NOT use Bash, Read, Grep, or any tools — just emit the tag directly in your response text. This is a 1-turn task.</system-hint>`);
    console.log(`[auto-context] REMIND intent detected${resolvedDt ? ` resolved=${resolvedDt}` : ''}`);
  }

  if (EVENT_INTENT.test(text) && !REMIND_INTENT.test(text)) {
    const resolvedDt = _resolveRemindDatetime(text, _tz);
    const dtHint = resolvedDt
      ? ` The resolved datetime is: ${resolvedDt}. Use this EXACT value for the datetime field — do NOT recalculate.`
      : ` Use timezone ${_tz}.`;
    parts.push(`<system-hint type="event">The user wants a calendar event created. You MUST emit an [EVENT: title="name" datetime="ISO" duration_minutes=120 location="venue" description="details" user_ids="sender-id"] tag in your TEXT RESPONSE.${dtHint} Do NOT use Bash, Read, Grep, or any tools — just emit the tag directly in your response text. This is a 1-turn task.</system-hint>`);
    console.log(`[auto-context] EVENT intent detected${resolvedDt ? ` resolved=${resolvedDt}` : ''}`);
  }

  if (EIGHTSLEEP_INTENT.test(text)) {
    parts.push(`<system-hint type="eightsleep">The user wants to control their Eight Sleep bed. You MUST emit an [EIGHTSLEEP: action side] tag. Actions: status, set <level>, on, off. Sides: left, right, my.</system-hint>`);
    console.log(`[auto-context] EIGHTSLEEP intent detected`);
  }

  if (parts.length === 0) return '';

  return parts.join('\n\n') + '\n\n';
}

module.exports = { enrichWithContext, CALENDAR_INTENT, WEATHER_INTENT, IMAGINE_INTENT, REMIND_INTENT, EVENT_INTENT, EIGHTSLEEP_INTENT, CONCERT_PRICE_INTENT };
