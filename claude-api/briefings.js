const schedule = require('node-schedule');
const https = require('https');
const http = require('http');
const path = require('path');
const { geocode: weatherGeocode } = require('./plugins/weather');
const config = require('./briefing-config');
const { loadActiveTasks, addTasks, formatTaskList } = require('./tasks-storage');
const { sendErrorAlert } = require('./error-alerting');
const { SIGNAL_OWNER } = require('./project-permissions');
const { getInternalToken } = require('./internal-token');
const INTERNAL_API_TOKEN = getInternalToken();

// Strip any unprocessed bot-tags from text before sending to Discord.
// Belt-and-suspenders: the briefing path doesn't run the Signal tag pipeline,
// so if Claude emits [WEATHER:], [CALENDAR:], etc. we must strip them so the
// user never sees raw tag syntax in their briefing.
function stripBotTags(text) {
  if (!text) return text;
  return text.replace(/\[(?:WEATHER|CALENDAR|REMIND|PRODUCT|EVENT|EIGHTSLEEP|CONCERT|LIGHTS|LEARNED|NOTE|RESOLVE_NOTE|EVENT_JOIN|IMAGINE):[^\]]*\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

const PERSONALITIES_DIR = path.join(__dirname, 'personalities');
const DEFAULT_PERSONALITY = 'tiffany_pollard';
const DEFAULT_IDENTITY = {
  name: 'Claude Bot',
  description: 'a helpful AI assistant on Signal. You are friendly, concise, and capable.'
};

// --- Data Fetchers ---

async function fetchStocks(stockConfig) {
  if (!stockConfig.enabled || !stockConfig.tickers.length) return null;

  try {
    const yahooFinance = require('yahoo-finance2').default;
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

        // Portfolio tracking if holdings configured
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

// --- Calendar Fetcher ---
// Hits the internal /calendar/events endpoint with SIGNAL_OWNER as the userId.
// Security: userId is hardcoded here to the Signal owner — NEVER parameterized
// from config or Claude output. This is the briefing owner's calendar only.
function fetchCalendar() {
  return new Promise((resolve) => {
    const today = new Date();
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + 7);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const body = JSON.stringify({
      userId: SIGNAL_OWNER,
      isGroupChat: false,
      fromDate: fmt(today),
      toDate: fmt(toDate),
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
          resolve(parsed?.text || null);
        } catch {
          console.warn('[briefing] calendar parse failed');
          resolve(null);
        }
      });
    });
    req.on('error', (err) => {
      console.warn(`[briefing] calendar fetch error: ${err.message}`);
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      console.warn('[briefing] calendar fetch timeout');
      resolve(null);
    });
    req.write(body); req.end();
  });
}

// --- Jobs Data Builder ---

function buildJobsSection(jobsConfig) {
  if (!jobsConfig || !jobsConfig.enabled) return null;

  return {
    titles: jobsConfig.titles,
    locations: jobsConfig.locations,
    companyCategories: jobsConfig.companyCategories,
    timeframe: jobsConfig.timeframe || '7 days',
  };
}

// --- Prompt Builder ---

function buildPrompt(stockData, weatherData, calendarText, jobsData, cfg, tasks = null) {
  const sections = [];

  sections.push(`You are writing a TIGHT morning briefing for Discord. HARD RULES:
- MUST fit in ONE Discord message (~1800 chars total, including markdown)
- Discord markdown only (bold, ## headers). NO emoji spam.
- Every line earns its place. Cut ruthlessly.
- Inline links only: [text](url). No "Sources:" footer.
- DO NOT emit tag syntax like [WEATHER:...] or [CALENDAR:...] — weather and calendar are pre-fetched below, just reformat them.
- USE WEB SEARCH for news/jobs. Real URLs only.`);

  // Stock data (pre-fetched, just format it)
  if (stockData && stockData.length > 0) {
    let stockSection = '## STOCK DATA (pre-fetched — use these exact numbers)\n';
    const hasHoldings = stockData.some(s => s.shares);

    for (const s of stockData) {
      if (s.error) {
        stockSection += `${s.ticker}: data unavailable\n`;
      } else {
        const sign = s.changePercent >= 0 ? '+' : '';
        stockSection += `${s.ticker}: $${s.price.toFixed(2)} (${sign}${s.changePercent.toFixed(2)}%)`;
        if (s.shares) {
          stockSection += ` — ${s.shares} shares, value $${s.totalValue.toFixed(2)}, ${s.gainLoss >= 0 ? '+' : ''}$${s.gainLoss.toFixed(2)} (${s.gainLossPercent >= 0 ? '+' : ''}${s.gainLossPercent.toFixed(1)}%)`;
        }
        stockSection += '\n';
      }
    }

    if (hasHoldings) {
      const totalValue = stockData.filter(s => s.shares).reduce((sum, s) => sum + (s.totalValue || 0), 0);
      const totalCost = stockData.filter(s => s.shares).reduce((sum, s) => sum + (s.totalCost || 0), 0);
      const totalGain = totalValue - totalCost;
      stockSection += `Portfolio total: $${totalValue.toFixed(2)} (${totalGain >= 0 ? '+' : ''}$${totalGain.toFixed(2)})\n`;
    }

    sections.push(stockSection);
  }

  // Weather data (pre-fetched)
  if (weatherData) {
    let weatherSection = `## WEATHER (pre-fetched — reformat, do NOT emit a [WEATHER:] tag)\n`;
    weatherSection += `${weatherData.location}: ${weatherData.condition}, ${weatherData.low}°–${weatherData.high}°${weatherData.units}, feels ${weatherData.feelsLike}°`;
    if (weatherData.chanceOfRain > 0) weatherSection += `, ${weatherData.chanceOfRain}% rain`;
    weatherSection += '\n';
    sections.push(weatherSection);
  }

  // Calendar data (pre-fetched from Signal owner's calendar)
  if (calendarText) {
    sections.push(`## CALENDAR — today + next 7 days (pre-fetched — reformat, do NOT emit a [CALENDAR:] tag)\n${calendarText}\n`);
  }

  // Instructions — tight, max ~1800 chars total output
  let instructions = '## YOUR TASK\nWrite the briefing. Total length MUST be under 1800 chars. Skip any section that has no real content.\n\n';
  let step = 1;

  // No standalone greeting — just lead with the weather line.
  // Weather
  if (weatherData) {
    instructions += `${step++}. **Weather** — ONE line from the data above.\n`;
  }

  // Calendar
  if (calendarText) {
    instructions += `${step++}. **Today** — ONE line listing today's calendar events (time + title). If nothing today, skip. Do NOT list the whole week — just today.\n`;
  }

  // Stocks — compact
  if (stockData && stockData.length > 0) {
    instructions += `${step++}. **Portfolio** — ONE line: total value + day's gain/loss. Skip per-ticker breakdown unless a ticker moved >3% (then add ONE line).\n`;
  }

  // Tasks for today
  if (tasks) {
    instructions += `${step++}. **Tasks** — Format each task below as ☐ on its own line. Do NOT add or change tasks:\n${tasks}\n`;
  }

  // News — tight, only top 3 items total
  if (cfg.news.enabled) {
    const topTopics = cfg.news.topics.slice(0, 3).map(t => `"${t.query}"`).join(', ');
    instructions += `${step++}. **News** — Web search these topics: ${topTopics}. Return the TOP 3 stories total (not per topic). One line each: **Headline** — [source](url). Prefer reuters.com, wired.com, theverge.com.\n`;
  }

  // Jobs — trimmed
  if (jobsData) {
    instructions += `${step++}. **Jobs** — Web search for ${jobsData.titles.join('/')} roles (${jobsData.locations.join(', ')}). Return TOP 3 only. Senior/Staff/Director+ ONLY. One line each: **Role** @ **Company** — [Apply](url).\n`;
  }

  // Mindfulness — keep it to 2 lines
  if (cfg.motivation.enabled && cfg.motivation.userContext) {
    const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: cfg.timezone || 'America/Los_Angeles' });
    const dayIndex = new Date().getDay();
    const techniques = [
      'body scan (progressive muscle relaxation from toes to head)',
      '4-7-8 breathing (inhale 4, hold 7, exhale 8)',
      '5-4-3-2-1 grounding (5 things you see, 4 hear, 3 touch, 2 smell, 1 taste)',
      'box breathing (4 in, 4 hold, 4 out, 4 hold — 4 rounds)',
      'mindful walking (focus on each step, feel the ground, no phone)',
      'loving-kindness meditation (send compassion to yourself, then someone you love, then a stranger)',
      'alternate nostril breathing (close right nostril inhale left, switch, exhale right, repeat)',
    ];
    const todayTechnique = techniques[dayIndex % techniques.length];
    instructions += `${step++}. **Mindfulness** — ${dayOfWeek}'s technique: "${todayTechnique}". ONE line with the instruction only. No wellness fluff.\n`;
  }

  instructions += '\nOne-line sign-off in character. HARD CAP: 1800 chars TOTAL. If over, cut news/jobs first.';

  if (cfg.motivation.userContext) {
    instructions += `\n\nContext: ${cfg.motivation.userContext}`;
  }

  sections.push(instructions);

  return sections.join('\n\n');
}

// --- Send Briefing ---

// Resolve the briefing recipient (Signal). config.channelId may hold a Signal
// chatId/phone; otherwise we fall back to SIGNAL_OWNER.
function _resolveRecipient() {
  let recipient = config.channelId || SIGNAL_OWNER || null;
  if (!recipient) return null;
  if (typeof recipient === 'string' && recipient.startsWith('signal:')) {
    recipient = recipient.replace(/^signal:/, '');
  }
  return recipient;
}

async function sendToChannel(_unused, text) {
  // Signal-only sender. The first param is kept for back-compat callers but
  // ignored — the recipient is resolved from config/SIGNAL_OWNER.
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

async function sendBriefing() {
  console.log('Running morning briefing...');

  const recipient = _resolveRecipient();
  if (!recipient) {
    console.error('Briefing failed: no recipient configured (config.channelId / SIGNAL_OWNER)');
    sendErrorAlert(new Error('No briefing recipient'), { source: 'sendBriefing' });
    return;
  }

  // Fetch data in parallel
  const [stockData, weatherData, calendarText] = await Promise.all([
    fetchStocks(config.stocks),
    fetchWeather(config.weather),
    fetchCalendar(),
  ]);

  if (!weatherData) console.warn('[briefing] weather pre-fetch returned null — Claude has no weather data');
  if (!calendarText) console.warn('[briefing] calendar pre-fetch returned null — Claude has no calendar data');

  const jobsData = buildJobsSection(config.jobs);
  const activeTasks = loadActiveTasks();
  const tasksText = formatTaskList(activeTasks);
  const prompt = buildPrompt(stockData, weatherData, calendarText, jobsData, config, tasksText);

  // Resolve identity and personality
  const { askClaude } = require('./bot');
  const identity = config.identity || DEFAULT_IDENTITY;
  const personalityName = config.personality || DEFAULT_PERSONALITY;
  const personalityFile = path.join(PERSONALITIES_DIR, `${personalityName}.md`);

  try {
    const result = await askClaude(prompt, {
      personalityFile,
      identity,
      cwd: '/app',
      maxTurns: 15,
      isOwner: true,
    });

    if (result.text) {
      const cleanText = stripBotTags(result.text);
      await sendToChannel(null, cleanText);
      console.log(`Briefing sent to ${recipient}${result.cost ? ` ($${result.cost.toFixed(4)})` : ''}`);
    } else {
      await sendToChannel(null, '(Morning briefing came back empty — Claude might be having a slow morning too)');
    }
  } catch (err) {
    console.error('Briefing Claude call failed:', err.message);
    await sendToChannel(null, '(Morning briefing failed to generate — check the logs)').catch(() => {});
    sendErrorAlert(err, { source: 'sendBriefing', detail: 'Claude call failed' });
  }
}

// --- Weekly Preview (Sunday) ---

function buildWeeklyPreviewPrompt(tasks) {
  const sections = [];

  sections.push(`You are writing a SHORT weekly preview for Discord. CRITICAL RULES:
- Use Discord markdown (bold, emoji, ## headers)
- Keep it SCANNABLE — bullet points, not paragraphs
- NO fluff, NO filler, NO long intros
- USE WEB SEARCH if needed for current info`);

  let instructions = `## YOUR TASK
Write a "Week Ahead" preview. Keep it SHORT and SCANNABLE.\n\n`;
  let step = 1;

  // Greeting
  instructions += `${step++}. **Greeting** — ONE sentence. Sunday vibes. In character.\n\n`;

  // Tasks
  if (tasks) {
    instructions += `${step++}. **Carry-over Tasks** — These tasks were saved and haven't been completed yet. Format each as ☐ on its own line:\n${tasks}\n\n`;
  }

  // Weekly goals
  instructions += `${step++}. **Weekly Goals** — Suggest 3-4 realistic, actionable goals for the week. Mix professional development (job search, skill building) and personal wellness (exercise, mindfulness, social). Keep each to one line. Base these on the user context below.\n\n`;

  // Week ahead prep
  instructions += `${step++}. **Week Ahead Prep** — USE WEB SEARCH to find:\n`;
  instructions += `- Any major events, holidays, or observances this week\n`;
  instructions += `- Key earnings reports or market events this week (relevant to user's portfolio: ${config.stocks.tickers.join(', ')})\n`;
  instructions += `- Any notable tech/AI conferences, announcements, or launches scheduled this week\n`;
  instructions += `Keep it to items that are actually relevant. Skip if nothing notable.\n\n`;

  // Weather outlook
  if (config.weather.enabled) {
    instructions += `${step++}. **Weather This Week** — USE WEB SEARCH to get the week's weather outlook for ${config.weather.location}. Just the highlights: any rain days, temperature trend, best days to be outside. 2-3 lines max.\n\n`;
  }

  // Motivation / intention setting
  if (config.motivation.enabled && config.motivation.userContext) {
    instructions += `${step++}. **Weekly Intention** — Suggest ONE intention or theme for the week. Keep it grounded and practical, tied to the user context below. One sentence, then a specific action they can take Monday morning to start the week right.\n\n`;
  }

  instructions += 'End with a one-line sign-off in character. THE ENTIRE MESSAGE SHOULD FIT IN ~2-3 DISCORD MESSAGES MAX.';

  if (config.motivation.userContext) {
    instructions += `\n\nUser context: ${config.motivation.userContext}`;
  }

  sections.push(instructions);
  return sections.join('\n\n');
}

async function sendWeeklyPreview() {
  console.log('Running Sunday weekly preview...');

  const recipient = _resolveRecipient();
  if (!recipient) {
    console.error('Weekly preview failed: no recipient configured');
    sendErrorAlert(new Error('No briefing recipient'), { source: 'sendWeeklyPreview' });
    return;
  }

  const activeTasks = loadActiveTasks();
  const tasksText = formatTaskList(activeTasks);
  const prompt = buildWeeklyPreviewPrompt(tasksText);

  const { askClaude } = require('./bot');
  const identity = config.identity || DEFAULT_IDENTITY;
  const personalityName = config.personality || DEFAULT_PERSONALITY;
  const personalityFile = path.join(PERSONALITIES_DIR, `${personalityName}.md`);

  try {
    const result = await askClaude(prompt, {
      personalityFile,
      identity,
      cwd: '/app',
      maxTurns: 15,
      isOwner: true,
    });

    if (result.text) {
      const cleanText = stripBotTags(result.text);
      await sendToChannel(null, cleanText);
      console.log(`Weekly preview sent to ${recipient}${result.cost ? ` ($${result.cost.toFixed(4)})` : ''}`);
    } else {
      await sendToChannel(null, '(Weekly preview came back empty)');
    }
  } catch (err) {
    console.error('Weekly preview failed:', err.message);
    await sendToChannel(null, '(Weekly preview failed to generate — check the logs)').catch(() => {});
    sendErrorAlert(err, { source: 'sendWeeklyPreview', detail: 'Claude call failed' });
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
    console.warn('Briefings: no recipient configured (config.channelId / SIGNAL_OWNER) — skipping scheduler');
    return;
  }

  schedule.scheduleJob(
    { rule: config.schedule, tz: config.timezone },
    () => sendBriefing()
  );

  console.log(`Briefing scheduled: "${config.schedule}" (${config.timezone}) → ${recipient}`);

  // Sunday weekly preview
  if (config.weeklyPreview?.enabled) {
    schedule.scheduleJob(
      { rule: config.weeklyPreview.schedule, tz: config.timezone },
      () => sendWeeklyPreview()
    );
    console.log(`Weekly preview scheduled: "${config.weeklyPreview.schedule}" (${config.timezone})`);
  }

  // Evening check-in — Signal-only. Posts a quick task-collection prompt to
  // the configured recipient. (The previous Discord wizard flow used the
  // channel.send/reply API; on Signal we just send the question and rely on
  // the user replying in DM, which Bianca answers via the normal pipeline.)
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
