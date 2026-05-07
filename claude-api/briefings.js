/**
 * Briefings — pure template formatting, no AI.
 * Morning briefing, weekly preview, and evening check-in.
 * All data is pre-fetched (stocks, weather, calendar, tasks, RSS news).
 */

const schedule = require('node-schedule');
const http = require('http');
const path = require('path');
const { geocode: weatherGeocode } = require('./plugins/weather');
const config = require('./briefing-config');
const { loadActiveTasks, formatTaskList } = require('./tasks-storage');
const { sendErrorAlert } = require('./error-alerting');
const { SIGNAL_OWNER } = require('./project-permissions');
const { getInternalToken } = require('./internal-token');
const { fetchFeeds, filterRecent } = require('./rss-fetcher');
const { generateEmailDigest } = require('./email-digest');
const { getProfile } = require('./user-profiles');
const INTERNAL_API_TOKEN = getInternalToken();

const NEWS_FEEDS = [
  'https://techcrunch.com/category/artificial-intelligence/feed/',
  'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
  'https://arstechnica.com/tag/artificial-intelligence/feed/',
  'https://www.wired.com/feed/tag/ai/latest/rss',
];

const SIGN_OFFS = [
  'Go get it today.',
  'You got this — one step at a time.',
  'Make today count.',
  'Stay sharp, stay kind.',
  'Own the day.',
  'Let\'s get after it.',
  'Today\'s a good day to build something.',
];

const MINDFULNESS = [
  'body scan — progressive muscle relaxation from toes to head, 5 minutes',
  '4-7-8 breathing — inhale 4s, hold 7s, exhale 8s, repeat 4 rounds',
  '5-4-3-2-1 grounding — 5 things you see, 4 hear, 3 touch, 2 smell, 1 taste',
  'box breathing — inhale 4s, hold 4s, exhale 4s, hold 4s, 4 rounds',
  'mindful walking — 10 minutes, focus on each step, feel the ground, no phone',
  'loving-kindness — send compassion to yourself, someone you love, then a stranger',
  'alternate nostril breathing — close right nostril inhale left, switch, exhale right',
];

// --- Data Fetchers ---

async function fetchStocks(stockConfig) {
  if (!stockConfig.enabled || !stockConfig.tickers.length) return null;

  try {
    const mod = await import('yahoo-finance2');
    const YahooFinance = mod.default;
    const yahooFinance = new YahooFinance();
    const results = [];

    for (const ticker of stockConfig.tickers) {
      try {
        const quote = await yahooFinance.quote(ticker);
        const data = {
          ticker,
          price: quote.regularMarketPrice,
          change: quote.regularMarketChange,
          changePercent: quote.regularMarketChangePercent,
          previousClose: quote.regularMarketPreviousClose,
        };

        if (stockConfig.holdings && stockConfig.holdings[ticker]) {
          const h = stockConfig.holdings[ticker];
          data.shares = h.shares;
          data.avgCost = h.avgCost;
          data.totalValue = data.price * h.shares;
          data.totalCost = h.avgCost * h.shares;
          data.gainLoss = data.totalValue - data.totalCost;
          data.gainLossPercent = ((data.totalValue - data.totalCost) / data.totalCost) * 100;
        }

        results.push(data);
      } catch (err) {
        console.warn(`Failed to fetch stock ${ticker}:`, err.message);
        results.push({ ticker, error: true });
      }
    }

    return results;
  } catch (err) {
    console.error('Stock fetcher failed:', err.message);
    return null;
  }
}

async function fetchWeather(weatherConfig) {
  if (!weatherConfig.enabled || !weatherConfig.location) return null;

  try {
    const place = await weatherGeocode(weatherConfig.location);
    if (!place) { console.error('[briefing] Weather geocode returned null for', weatherConfig.location); return null; }

    const params = new URLSearchParams({
      latitude: String(place.lat),
      longitude: String(place.lon),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      precipitation_unit: 'inch',
      timezone: place.tz,
      forecast_days: '1',
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = await res.json();

    const WMO = {
      0:'Clear',1:'Mostly clear',2:'Partly cloudy',3:'Overcast',
      45:'Fog',48:'Icy fog',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',
      61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',
      80:'Light showers',81:'Showers',82:'Heavy showers',95:'Thunderstorm',
    };
    const code = data.current?.weather_code;
    const condition = WMO[code] || `Code ${code}`;

    return {
      location: `${place.name}, ${place.region}`,
      high: Math.round(data.daily?.temperature_2m_max?.[0] ?? 0),
      low: Math.round(data.daily?.temperature_2m_min?.[0] ?? 0),
      units: 'F',
      condition,
      feelsLike: Math.round(data.current?.apparent_temperature ?? data.current?.temperature_2m ?? 0),
      humidity: data.current?.relative_humidity_2m ?? null,
      chanceOfRain: data.daily?.precipitation_probability_max?.[0] ?? 0,
    };
  } catch (err) {
    console.error('Weather fetch failed:', err.message);
    return null;
  }
}

function fetchCalendar(days = 7) {
  return new Promise((resolve) => {
    const _tz = getProfile(SIGNAL_OWNER)?.timezone || config.timezone || 'America/Los_Angeles';
    const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: _tz }));
    const fromDate = localNow.toISOString().slice(0, 10);
    const toDate = new Date(localNow);
    toDate.setDate(toDate.getDate() + days);
    const toDateStr = toDate.toISOString().slice(0, 10);
    const body = JSON.stringify({
      userId: SIGNAL_OWNER,
      isGroupChat: false,
      fromDate,
      toDate: toDateStr,
      timezone: _tz,
    });
    const req = http.request({
      hostname: 'localhost', port: 3400, path: '/calendar/events',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_API_TOKEN, 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ text: parsed?.text || null, events: parsed?.events || [] });
        } catch {
          console.warn('[briefing] calendar parse failed');
          resolve({ text: null, events: [] });
        }
      });
    });
    req.on('error', (err) => {
      console.warn(`[briefing] calendar fetch error: ${err.message}`);
      resolve({ text: null, events: [] });
    });
    req.on('timeout', () => {
      req.destroy();
      console.warn('[briefing] calendar fetch timeout');
      resolve({ text: null, events: [] });
    });
    req.write(body); req.end();
  });
}

async function fetchTopNews(count = 3) {
  try {
    const items = await fetchFeeds(NEWS_FEEDS);
    const recent = filterRecent(items, 24 * 60 * 60 * 1000); // last 24h
    recent.sort((a, b) => {
      if (!a.pubDate) return 1;
      if (!b.pubDate) return -1;
      return b.pubDate.getTime() - a.pubDate.getTime();
    });
    // Deduplicate by title similarity
    const seen = new Set();
    const unique = [];
    for (const item of recent) {
      const key = item.title.substring(0, 60).toLowerCase().replace(/[^a-z0-9 ]/g, '');
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
      if (unique.length >= count) break;
    }
    return unique;
  } catch (err) {
    console.warn('[briefing] News fetch failed:', err.message);
    return [];
  }
}

// --- Template Formatters ---

function formatWeatherLine(w) {
  if (!w) return null;
  let line = `☀️ **${w.location}**: ${w.condition}, ${w.low}°–${w.high}°${w.units} (feels ${w.feelsLike}°)`;
  if (w.chanceOfRain > 0) line += ` — ${w.chanceOfRain}% rain`;
  return line;
}

function formatCalendarToday(calendarText, events) {
  if (!events || events.length === 0) return calendarText ? `📅 **Today**\n${calendarText}` : null;

  const _tz = getProfile(SIGNAL_OWNER)?.timezone || config.timezone || 'America/Los_Angeles';
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: _tz }));
  const todayStr = nowLocal.toISOString().slice(0, 10);

  const seen = new Set();
  const todayEvents = events.filter(e => {
    const startStr = e.start || '';
    // All-day events: start is just a date like "2026-05-03"
    const isAllDay = startStr.length === 10;
    // For all-day multi-day events, only show if today falls within range
    if (isAllDay) {
      const end = e.end || startStr;
      if (todayStr < startStr || todayStr >= end) return false;
    } else {
      // Timed events: check the date portion in user's timezone
      const eventDate = new Date(startStr);
      const eventLocal = new Date(eventDate.toLocaleString('en-US', { timeZone: _tz }));
      const eventDateStr = eventLocal.toISOString().slice(0, 10);
      if (eventDateStr !== todayStr) return false;
    }
    // Dedup by title + start time
    const key = `${e.title}|${e.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (todayEvents.length === 0) return null;

  const lines = todayEvents.map(e => {
    const isAllDay = (e.start || '').length === 10;
    if (isAllDay) return `• ${e.title}${e.location ? ' @ ' + e.location : ''}`;
    const startDate = new Date(e.start);
    const h = startDate.toLocaleString('en-US', { timeZone: _tz, hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase().replace(':00', '').replace(' ', '');
    return `• ${h} ${e.title}${e.location ? ' @ ' + e.location : ''}`;
  });

  return `📅 **Today**\n${lines.join('\n')}`;
}

function formatPortfolio(stocks) {
  if (!stocks || stocks.length === 0) return null;

  const withHoldings = stocks.filter(s => s.shares && !s.error);
  if (withHoldings.length === 0) return null;

  const totalValue = withHoldings.reduce((sum, s) => sum + (s.totalValue || 0), 0);
  const totalCost = withHoldings.reduce((sum, s) => sum + (s.totalCost || 0), 0);
  const dayGain = withHoldings.reduce((sum, s) => sum + ((s.change || 0) * (s.shares || 0)), 0);
  const totalGain = totalValue - totalCost;

  const sign = dayGain >= 0 ? '+' : '';
  const totalSign = totalGain >= 0 ? '+' : '';
  let line = `📈 **Portfolio**: $${totalValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} (${sign}$${dayGain.toFixed(0)} today, ${totalSign}$${totalGain.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} all-time)`;

  // Flag big movers (>3%)
  const bigMovers = stocks.filter(s => !s.error && Math.abs(s.changePercent || 0) > 3);
  if (bigMovers.length > 0) {
    const moverStrs = bigMovers.map(s => {
      const ms = s.changePercent >= 0 ? '+' : '';
      return `${s.ticker} ${ms}${s.changePercent.toFixed(1)}%`;
    });
    line += `\n   Notable: ${moverStrs.join(', ')}`;
  }

  return line;
}

function formatTasks(tasksText) {
  if (!tasksText) return null;
  return `✅ **Tasks**\n${tasksText}`;
}

function formatNewsSection(newsItems) {
  if (!newsItems || newsItems.length === 0) return null;
  const bullets = newsItems.map(item => {
    const source = item.source.charAt(0).toUpperCase() + item.source.slice(1);
    return `• [${source}](${item.link}) ${item.title}`;
  });
  return `📰 **Headlines**\n${bullets.join('\n')}`;
}

function formatMindfulness() {
  if (!config.motivation.enabled) return null;
  const dayIndex = new Date().getDay();
  const technique = MINDFULNESS[dayIndex % MINDFULNESS.length];
  return `🧘 **Mindfulness**: ${technique}`;
}

function _resolveRecipient() {
  // Prefer SIGNAL_OWNER for Signal delivery. config.channelId is a legacy
  // Discord channel ID that doesn't work with the Signal adapter.
  let recipient = SIGNAL_OWNER || null;
  if (!recipient) return null;
  if (typeof recipient === 'string' && recipient.startsWith('signal:')) {
    recipient = recipient.replace(/^signal:/, '');
  }
  return recipient;
}

async function sendToChannel(text) {
  const { signalAdapter } = require('./bot');
  const recipient = _resolveRecipient();
  if (!recipient || !signalAdapter || !signalAdapter.ready) {
    console.warn('[briefing] no Signal recipient or adapter; dropping briefing');
    return;
  }
  if (!text || text.length === 0) {
    await signalAdapter.sendMessage(recipient, '(Briefing generated no output)').catch(() => {});
    return;
  }
  await signalAdapter.sendLongMessage(recipient, text).catch(err => {
    console.warn(`[briefing] sendLongMessage failed: ${err.message}`);
  });
}

// --- Morning Briefing ---

async function sendBriefing() {
  console.log('[briefing] Running morning briefing (template mode)...');

  const recipient = _resolveRecipient();
  if (!recipient) {
    console.error('Briefing failed: no recipient configured');
    sendErrorAlert(new Error('No briefing recipient'), { source: 'sendBriefing' });
    return;
  }

  try {
    const [stockData, weatherData, calendarResult, newsItems, emailDigest] = await Promise.all([
      fetchStocks(config.stocks),
      fetchWeather(config.weather),
      fetchCalendar(1),
      fetchTopNews(3),
      generateEmailDigest(SIGNAL_OWNER, 24).catch(err => {
        console.warn(`[briefing] Email digest failed: ${err.message}`);
        return null;
      }),
    ]);

    const activeTasks = loadActiveTasks();
    const tasksText = formatTaskList(activeTasks);

    const sections = [];

    const _briefingTz = getProfile(SIGNAL_OWNER)?.timezone || config.timezone || 'America/Los_Angeles';
    const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: _briefingTz });
    sections.push(`**Good morning** — Happy ${dayOfWeek}.`);

    const weatherLine = formatWeatherLine(weatherData);
    if (weatherLine) sections.push(weatherLine);

    const calendarLine = formatCalendarToday(calendarResult.text, calendarResult.events);
    if (calendarLine) sections.push(calendarLine);

    const portfolioLine = formatPortfolio(stockData);
    if (portfolioLine) sections.push(portfolioLine);

    const tasksSection = formatTasks(tasksText);
    if (tasksSection) sections.push(tasksSection);

    if (emailDigest && !emailDigest.includes('No emails') && !emailDigest.includes('not connected')) {
      sections.push(emailDigest);
    }

    const newsSection = formatNewsSection(newsItems);
    if (newsSection) sections.push(newsSection);

    const mindfulness = formatMindfulness();
    if (mindfulness) sections.push(mindfulness);

    const signOff = SIGN_OFFS[new Date().getDay() % SIGN_OFFS.length];
    sections.push(`\n${signOff}`);

    const text = sections.join('\n\n');
    await sendToChannel(text);
    console.log(`[briefing] Sent morning briefing to ${recipient} (template mode, ${text.length} chars)`);
  } catch (err) {
    console.error('[briefing] Failed:', err.message);
    await sendToChannel('(Morning briefing failed to generate — check the logs)').catch(() => {});
    sendErrorAlert(err, { source: 'sendBriefing', detail: 'Template formatting failed' });
  }
}

// --- Weekly Preview ---

async function sendWeeklyPreview() {
  console.log('[briefing] Running weekly preview (template mode)...');

  const recipient = _resolveRecipient();
  if (!recipient) {
    console.error('Weekly preview failed: no recipient configured');
    sendErrorAlert(new Error('No briefing recipient'), { source: 'sendWeeklyPreview' });
    return;
  }

  try {
    const [calendarResult, newsItems] = await Promise.all([
      fetchCalendar(7),
      fetchTopNews(5),
    ]);

    const activeTasks = loadActiveTasks();
    const tasksText = formatTaskList(activeTasks);

    const sections = [];

    sections.push('**📋 Week Ahead**');

    if (calendarResult.text) {
      sections.push(`📅 **Schedule**\n${calendarResult.text}`);
    }

    if (tasksText) {
      sections.push(`✅ **Open Tasks**\n${tasksText}`);
    }

    if (newsItems && newsItems.length > 0) {
      const bullets = newsItems.map(item => {
        const source = item.source.charAt(0).toUpperCase() + item.source.slice(1);
        return `• [${source}](${item.link}) ${item.title}`;
      });
      sections.push(`📰 **What's Happening**\n${bullets.join('\n')}`);
    }

    const signOff = SIGN_OFFS[Math.floor(Math.random() * SIGN_OFFS.length)];
    sections.push(`\n${signOff}`);

    const text = sections.join('\n\n');
    await sendToChannel(text);
    console.log(`[briefing] Sent weekly preview to ${recipient} (template mode, ${text.length} chars)`);
  } catch (err) {
    console.error('[briefing] Weekly preview failed:', err.message);
    await sendToChannel('(Weekly preview failed to generate — check the logs)').catch(() => {});
    sendErrorAlert(err, { source: 'sendWeeklyPreview', detail: 'Template failed' });
  }
}

// --- Scheduler ---

function startScheduler() {
  if (!config.enabled) {
    console.log('Briefings: disabled in config');
    return;
  }

  const recipient = _resolveRecipient();
  if (!recipient) {
    console.warn('Briefings: no recipient configured — skipping scheduler');
    return;
  }

  schedule.scheduleJob(
    { rule: config.schedule, tz: config.timezone },
    () => sendBriefing()
  );

  console.log(`Briefing scheduled: "${config.schedule}" (${config.timezone}) → ${recipient} [template mode]`);

  if (config.weeklyPreview?.enabled) {
    schedule.scheduleJob(
      { rule: config.weeklyPreview.schedule, tz: config.timezone },
      () => sendWeeklyPreview()
    );
    console.log(`Weekly preview scheduled: "${config.weeklyPreview.schedule}" (${config.timezone}) [template mode]`);
  }

  if (config.eveningCheckin?.enabled) {
    schedule.scheduleJob(
      { rule: config.eveningCheckin.schedule, tz: config.timezone },
      async () => {
        const { signalAdapter } = require('./bot');
        if (!signalAdapter || !signalAdapter.ready) {
          console.warn('[eveningCheckin] Signal adapter not ready, skipping');
          return;
        }
        await signalAdapter.sendMessage(
          recipient,
          "Hey — what do you need to get done tomorrow? Reply with your task list and I'll add them to your board."
        ).catch(err => {
          sendErrorAlert(err, { source: 'eveningCheckin', detail: 'Signal send failed' });
        });
      }
    );
    console.log(`Evening check-in scheduled: "${config.eveningCheckin.schedule}" (${config.timezone})`);
  }
}

module.exports = { startScheduler, sendBriefing, sendWeeklyPreview };
