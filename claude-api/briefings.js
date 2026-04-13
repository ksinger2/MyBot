const schedule = require('node-schedule');
const https = require('https');
const path = require('path');
const { MessageFlags } = require('discord.js');
const config = require('./briefing-config');
const { loadActiveTasks, addTasks, formatTaskList } = require('./tasks-storage');
const { sendErrorAlert } = require('./error-alerting');

const PERSONALITIES_DIR = path.join(__dirname, 'personalities');
const DEFAULT_PERSONALITY = 'tiffany_pollard';
const DEFAULT_IDENTITY = {
  name: 'Claude Bot',
  description: 'a helpful AI assistant on Discord. You are friendly, concise, and capable.'
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

function fetchWeather(weatherConfig) {
  if (!weatherConfig.enabled || !weatherConfig.location) return Promise.resolve(null);

  const units = weatherConfig.units || 'u';
  const location = encodeURIComponent(weatherConfig.location);
  const url = `https://wttr.in/${location}?format=j1&${units}`;

  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const today = parsed.weather?.[0];
          const current = parsed.current_condition?.[0];
          if (!today) { resolve(null); return; }

          resolve({
            location: weatherConfig.location,
            high: today.maxtempF || today.maxtempC,
            low: today.mintempF || today.mintempC,
            units: units === 'u' ? 'F' : 'C',
            condition: current?.weatherDesc?.[0]?.value || 'Unknown',
            feelsLike: current?.FeelsLikeF || current?.FeelsLikeC,
            humidity: current?.humidity,
            chanceOfRain: today.hourly?.reduce((max, h) => Math.max(max, parseInt(h.chanceofrain) || 0), 0),
            hourly: today.hourly?.map(h => ({
              time: h.time.padStart(4, '0').replace(/(\d{2})(\d{2})/, '$1:$2'),
              temp: units === 'u' ? h.tempF : h.tempC,
              condition: h.weatherDesc?.[0]?.value,
              chanceOfRain: h.chanceofrain,
            })),
          });
        } catch (err) {
          console.error('Weather parse failed:', err.message);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('Weather fetch failed:', err.message);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      console.error('Weather fetch timed out');
      resolve(null);
    });
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

function buildPrompt(stockData, weatherData, jobsData, cfg, tasks = null) {
  const sections = [];

  sections.push(`You are writing a SHORT morning briefing for Discord. CRITICAL RULES:
- Use Discord markdown (bold, emoji, ## headers)
- Keep it SCANNABLE — bullet points, not paragraphs
- NO fluff, NO filler, NO long intros
- Every news item MUST have a link to an article
- Every job listing MUST have a link to the posting
- USE WEB SEARCH to find real, current information with real URLs
- DO NOT add a "Sources:", "References:", or any link list at the bottom — links go inline with each item only`);

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
    let weatherSection = `## WEATHER — ${weatherData.location} (pre-fetched)\n`;
    weatherSection += `${weatherData.condition}, ${weatherData.low}°–${weatherData.high}°${weatherData.units}, feels like ${weatherData.feelsLike}°${weatherData.units}`;
    if (weatherData.humidity) weatherSection += `, ${weatherData.humidity}% humidity`;
    if (weatherData.chanceOfRain > 0) weatherSection += `, ${weatherData.chanceOfRain}% rain chance`;
    weatherSection += '\n';
    sections.push(weatherSection);
  }

  // Instructions
  let instructions = '## YOUR TASK\nWrite the briefing with these sections. Keep it SHORT and SCANNABLE.\n\n';
  let step = 1;

  // Greeting — one line max
  instructions += `${step++}. **Greeting** — ONE sentence. In character. No motivational speech.\n\n`;

  // Weather — just reformat the data above, 1-2 lines
  if (weatherData) {
    instructions += `${step++}. **Weather** — Reformat the weather data above into 1-2 lines. Just the key info: temp range, conditions, rain risk. Skip hourly breakdown.\n\n`;
  }

  // Stocks — compact table (always included, fallback to web search if no pre-fetched data)
  if (stockData && stockData.length > 0) {
    instructions += `${step++}. **Stocks** — Present the pre-fetched stock data above in a compact format. One line per ticker. Portfolio total at end. No commentary needed unless something moved more than 3%.\n\n`;
  } else {
    const tickers = config.stocks.tickers.join(', ');
    instructions += `${step++}. **Stocks** — Pre-fetched data unavailable. USE WEB SEARCH to get current prices for: ${tickers}. Show price and % change for each. One line per ticker.\n\n`;
  }

  // Tasks for today
  if (tasks) {
    instructions += `${step++}. **Today's Tasks** — The user set these tasks for today. Format each as a ☐ checkbox on its own line. Do NOT modify or add to the task list — just format what's here:\n${tasks}\n\n`;
  }

  // News — this is the big one, needs web search
  if (cfg.news.enabled) {
    instructions += `${step++}. **News** — USE WEB SEARCH for each topic below. I need SPECIFIC details about what happened, not vague summaries. Each item MUST include a link to the source article.\n\n`;
    instructions += `Search for and report on:\n`;
    for (const topic of cfg.news.topics) {
      instructions += `- "${topic.query}" (last ${topic.timeframe})${topic.depth === 'detailed' ? ' — give me specifics: who, what, when, consequences' : ' — 1-2 bullet points'}\n`;
    }
    instructions += `\nPriority sources: prefer articles from wired.com, theverge.com, and reuters.com. Use site: search operators to find them (e.g. "site:wired.com AI news", "site:theverge.com tech acquisition"). Use the article URL from search results directly — do NOT attempt to fetch or scrape these pages (they block bots).\n`;
    instructions += `\nFormat each news item as:\n**Headline** — 1-2 sentence summary of EXACTLY what happened. [Read more](url)\n\nIMPORTANT: All article links MUST be hyperlinked text using [text](url) markdown format. Do NOT paste bare URLs. Do NOT use Discord embed-style links — wrap URLs in < > angle brackets to suppress embeds if needed. Keep it compact.\n\n`;
  }

  // Jobs — needs web search
  if (jobsData) {
    instructions += `${step++}. **Jobs** — USE WEB SEARCH to find real Product Management job postings from the last ${jobsData.timeframe}. Search for:\n`;
    instructions += `Roles: ${jobsData.titles.join(', ')}\n`;
    instructions += `Locations: ${jobsData.locations.join(', ')}\n`;
    instructions += `SENIORITY: Senior, Staff, Director, VP, or Head of Product ONLY. The user has 10+ years of experience. Do NOT include Associate PM, APM, junior PM, entry-level, or mid-level roles. If a title doesn't say Senior/Staff/Director/VP/Head, SKIP IT.\n`;
    instructions += `Company categories to search:\n`;
    for (const cat of jobsData.companyCategories) {
      instructions += `- ${cat}\n`;
    }
    instructions += `\nFor each job found, format as:\n**Role** at **Company** (Location) — [Apply](url)\n`;
    instructions += `Find at least 3-5 real, current postings. Only include jobs with working links.\n\n`;
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
    instructions += `${step++}. **Mindfulness** — Today is ${dayOfWeek}. Use this technique today: "${todayTechnique}". Describe it in 2 lines max with specific instructions. NO news, NO AI articles, NO tech content, NO links. This section is STRICTLY wellness only.\n\n`;
  }

  instructions += 'End with a one-line sign-off in character. THE ENTIRE BRIEFING SHOULD FIT IN ~3 DISCORD MESSAGES MAX.';

  if (cfg.motivation.userContext) {
    instructions += `\n\nContext: ${cfg.motivation.userContext}`;
  }

  sections.push(instructions);

  return sections.join('\n\n');
}

// --- Send Briefing ---

async function sendToChannel(channel, text) {
  if (!text || text.length === 0) {
    await channel.send('*(Briefing generated no output)*');
    return;
  }

  const sendOpts = (content) => ({ content, flags: [MessageFlags.SuppressEmbeds] });

  if (text.length <= 1900) {
    await channel.send(sendOpts(text));
    return;
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 1900) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', 1900);
    if (splitAt < 500) splitAt = 1900;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }

  for (let i = 0; i < chunks.length && i < 8; i++) {
    await channel.send(sendOpts(chunks[i]));
  }
  if (chunks.length > 8) {
    await channel.send(`*(${chunks.length - 8} more sections truncated)*`);
  }
}

async function sendBriefing(client) {
  console.log('Running morning briefing...');

  const channel = await client.channels.fetch(config.channelId).catch(() => null);
  if (!channel) {
    console.error(`Briefing failed: cannot access channel ${config.channelId}`);
    sendErrorAlert(new Error(`Cannot access channel ${config.channelId}`), { source: 'sendBriefing', detail: 'Channel fetch failed' });
    return;
  }

  // Fetch data in parallel
  const [stockData, weatherData] = await Promise.all([
    fetchStocks(config.stocks),
    fetchWeather(config.weather),
  ]);

  const jobsData = buildJobsSection(config.jobs);
  const activeTasks = loadActiveTasks();
  const tasksText = formatTaskList(activeTasks);
  const prompt = buildPrompt(stockData, weatherData, jobsData, config, tasksText);

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
    });

    if (result.text) {
      await sendToChannel(channel, result.text);
      console.log(`Briefing sent to #${channel.name || config.channelId}${result.cost ? ` ($${result.cost.toFixed(4)})` : ''}`);
    } else {
      await channel.send('*(Morning briefing came back empty — Claude might be having a slow morning too)*');
    }
  } catch (err) {
    console.error('Briefing Claude call failed:', err.message);
    await channel.send('*(Morning briefing failed to generate — check the logs)*').catch(() => {});
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

async function sendWeeklyPreview(client) {
  console.log('Running Sunday weekly preview...');

  const channel = await client.channels.fetch(config.channelId).catch(() => null);
  if (!channel) {
    console.error(`Weekly preview failed: cannot access channel ${config.channelId}`);
    sendErrorAlert(new Error(`Cannot access channel ${config.channelId}`), { source: 'sendWeeklyPreview', detail: 'Channel fetch failed' });
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
    });

    if (result.text) {
      await sendToChannel(channel, result.text);
      console.log(`Weekly preview sent to #${channel.name || config.channelId}${result.cost ? ` ($${result.cost.toFixed(4)})` : ''}`);
    } else {
      await channel.send('*(Weekly preview came back empty)*');
    }
  } catch (err) {
    console.error('Weekly preview failed:', err.message);
    await channel.send('*(Weekly preview failed to generate — check the logs)*').catch(() => {});
    sendErrorAlert(err, { source: 'sendWeeklyPreview', detail: 'Claude call failed' });
  }
}

// --- Scheduler ---

function startScheduler(client) {
  if (!config.enabled) {
    console.log('Briefings: disabled in config');
    return;
  }

  if (!config.channelId) {
    console.warn('Briefings: no channelId configured — skipping scheduler');
    return;
  }

  schedule.scheduleJob(
    { rule: config.schedule, tz: config.timezone },
    () => sendBriefing(client)
  );

  console.log(`Briefing scheduled: "${config.schedule}" (${config.timezone}) → channel ${config.channelId}`);

  // Sunday weekly preview
  if (config.weeklyPreview?.enabled) {
    schedule.scheduleJob(
      { rule: config.weeklyPreview.schedule, tz: config.timezone },
      () => sendWeeklyPreview(client)
    );
    console.log(`Weekly preview scheduled: "${config.weeklyPreview.schedule}" (${config.timezone})`);
  }

  // Evening check-in
  if (config.eveningCheckin?.enabled) {
    schedule.scheduleJob(
      { rule: config.eveningCheckin.schedule, tz: config.timezone },
      async () => {
        const channel = await client.channels.fetch(config.channelId).catch(() => null);
        if (!channel) {
          sendErrorAlert(new Error(`Cannot access channel ${config.channelId}`), { source: 'eveningCheckin', detail: 'Channel fetch failed' });
          return;
        }
        const { getChannelState } = require('./bot');
        const { startWizard } = require('./wizard');
        const { addTasks: addNewTasks } = require('./tasks-storage');
        const state = getChannelState(config.channelId);
        await startWizard(state, { reply: (msg) => channel.send(msg), channel }, {
          type: 'eveningTasks',
          steps: [{
            key: 'tasks',
            prompt: "Hey girl 🐄 What do you need to get done tomorrow? Drop your task list and I'll add them to your board. (Just reply right here — I'm listening!)",
          }],
          onComplete: async (data, msg) => {
            addNewTasks(data.tasks);
            await msg.reply("Added to your task board! They'll show up in every briefing until you mark them done with `!done <#>` 🐄");
          },
        });
      }
    );
    console.log(`Evening check-in scheduled: "${config.eveningCheckin.schedule}" (${config.timezone})`);
  }
}

module.exports = { startScheduler, sendBriefing, sendWeeklyPreview };
