const schedule = require('node-schedule');
const https = require('https');
const path = require('path');
const config = require('./briefing-config');

const PERSONALITIES_DIR = path.join(__dirname, 'personalities');
const DEFAULT_PERSONALITY = 'tiffany_pollard';
const DEFAULT_IDENTITY = {
  name: 'Bianca',
  description: 'a fabulous cow named Bianca (aka Bianca Da Cow). You are a cow and you know it — work in cow puns, references to being a cow, mooing, grazing, etc. when it feels natural, but don\'t overdo it.'
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

function buildPrompt(stockData, weatherData, jobsData, cfg) {
  const sections = [];

  sections.push(`You are writing a SHORT morning briefing for Discord. CRITICAL RULES:
- Use Discord markdown (bold, emoji, ## headers)
- Keep it SCANNABLE — bullet points, not paragraphs
- NO fluff, NO filler, NO long intros
- Every news item MUST have a link to an article
- Every job listing MUST have a link to the posting
- USE WEB SEARCH to find real, current information with real URLs`);

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

  // Stocks — compact table
  if (stockData) {
    instructions += `${step++}. **Stocks** — YOU MUST INCLUDE THIS SECTION. Present the pre-fetched stock data above in a compact format. One line per ticker. Portfolio total at end. No commentary needed unless something moved more than 3%. Do NOT skip this section.\n\n`;
  }

  // News — this is the big one, needs web search
  if (cfg.news.enabled) {
    instructions += `${step++}. **News** — USE WEB SEARCH for each topic below. I need SPECIFIC details about what happened, not vague summaries. Each item MUST include a link to the source article.\n\n`;
    instructions += `Search for and report on:\n`;
    for (const topic of cfg.news.topics) {
      instructions += `- "${topic.query}" (last ${topic.timeframe})${topic.depth === 'detailed' ? ' — give me specifics: who, what, when, consequences' : ' — 1-2 bullet points'}\n`;
    }
    instructions += `\nFormat each news item as:\n**Headline** — 1-2 sentence summary of EXACTLY what happened. [Read more](url)\n\n`;
  }

  // Jobs — needs web search
  if (jobsData) {
    instructions += `${step++}. **Jobs** — USE WEB SEARCH to find real Product Management job postings from the last ${jobsData.timeframe}. Search for:\n`;
    instructions += `Roles: ${jobsData.titles.join(', ')}\n`;
    instructions += `Locations: ${jobsData.locations.join(', ')}\n`;
    instructions += `Company categories to search:\n`;
    for (const cat of jobsData.companyCategories) {
      instructions += `- ${cat}\n`;
    }
    instructions += `\nFor each job found, format as:\n**Role** at **Company** (Location) — [Apply](url)\n`;
    instructions += `Find at least 3-5 real, current postings. Only include jobs with working links.\n\n`;
  }

  // Mindfulness — keep it to 2 lines
  if (cfg.motivation.enabled && cfg.motivation.userContext) {
    instructions += `${step++}. **Mindfulness** — ONE specific exercise in 2 lines max. E.g., "Box breathing: 4 in, 4 hold, 4 out, 4 hold — 4 rounds before opening your laptop." Rotate techniques daily.\n\n`;
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

  if (text.length <= 1900) {
    await channel.send(text);
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
    await channel.send(chunks[i]);
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
    return;
  }

  // Fetch data in parallel
  const [stockData, weatherData] = await Promise.all([
    fetchStocks(config.stocks),
    fetchWeather(config.weather),
  ]);

  const jobsData = buildJobsSection(config.jobs);
  const prompt = buildPrompt(stockData, weatherData, jobsData, config);

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
}

module.exports = { startScheduler, sendBriefing };
