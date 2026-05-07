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

const EIGHTSLEEP_INTENT = /\b(bed|eight\s*sleep|eightsleep|mattress|pod|side)\b.*\b(on|off|warm|cool|cold|hot|temperature|temp|status|level|set|turn|switch)\b|\b(turn|switch)\s+(on|off|up|down)\s+(my\s+|the\s+)?(bed|mattress|pod|side)\b|\bhow\s+(warm|cool|cold|hot)\s+is\s+(my\s+)?(bed|mattress|side|pod)\b|\bhow('s| is) (my )?(bed|mattress|side|pod)\b|\bmake\s+(my\s+)?(bed|side|pod)\s+(warm|cool|cold|hot|cooler|warmer)\b/i;

// Date range extraction from natural language
function _extractDateRange(text, timezone = 'America/New_York') {
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
  return d.toISOString().slice(0, 10);
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

  const _tz = profile?.timezone || 'America/New_York';

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

  // ── Action intent hints — nudge Claude to emit the correct tag ──
  // These are injected as system context so Claude doesn't have to "remember"
  // the tag syntax from the system prompt. The hint makes tag emission near-certain.

  if (IMAGINE_INTENT.test(text)) {
    parts.push(`<system-hint type="image-generation">The user wants an image generated. You MUST emit an [IMAGINE: detailed description] tag. Do NOT describe what you would draw — emit the tag so the image is actually created.</system-hint>`);
    console.log(`[auto-context] IMAGINE intent detected`);
  }

  if (REMIND_INTENT.test(text)) {
    parts.push(`<system-hint type="reminder">The user wants a reminder set. You MUST emit a [REMIND: title="what" datetime="ISO 8601" duration_minutes=15] tag with ${_tz} timezone. Parse the time from their message.</system-hint>`);
    console.log(`[auto-context] REMIND intent detected`);
  }

  if (EIGHTSLEEP_INTENT.test(text)) {
    parts.push(`<system-hint type="eightsleep">The user wants to control their Eight Sleep bed. You MUST emit an [EIGHTSLEEP: action side] tag. Actions: status, set <level>, on, off. Sides: left, right, my.</system-hint>`);
    console.log(`[auto-context] EIGHTSLEEP intent detected`);
  }

  if (parts.length === 0) return '';

  return parts.join('\n\n') + '\n\n';
}

module.exports = { enrichWithContext, CALENDAR_INTENT, WEATHER_INTENT, IMAGINE_INTENT, REMIND_INTENT, EIGHTSLEEP_INTENT };
