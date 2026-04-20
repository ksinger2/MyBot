/**
 * AI News Pulse — every 3 hours
 * Searches for new AI industry news and sends bullet-point TLDRs to Discord.
 * Deduplicates across cycles so you only see new stories each time.
 */

const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');
const { SIGNAL_OWNER } = require('./project-permissions');

// Persist seen headlines so we don't repeat across 3-hour cycles
const SEEN_FILE = path.join(__dirname, 'data', 'ai-news-seen.json');
const MAX_SEEN = 500; // cap memory

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
    }
  } catch {}
  return new Set();
}

function saveSeen(seen) {
  try {
    // Keep only the last MAX_SEEN entries
    const arr = [...seen].slice(-MAX_SEEN);
    atomicWriteJsonSync(SEEN_FILE, arr, { spaces: 0 });
  } catch (err) {
    console.warn('[ai-news] Could not save seen file:', err.message);
  }
}

// --- Config ---

const AI_NEWS_CONFIG = {
  enabled: true,
  // Every 3 hours
  schedule: '0 8,11,14,17,20 * * *',
  timezone: 'America/Los_Angeles',
  // Signal recipient — defaults to the bot owner. Override by setting
  // AI_NEWS_RECIPIENT in the environment.
  recipient: process.env.AI_NEWS_RECIPIENT || SIGNAL_OWNER || null,
};

// Companies + topics to track
const TOPICS = [
  'Anthropic Claude AI news announcement',
  'OpenAI GPT news announcement product',
  'Google Gemini DeepMind AI news',
  'Meta AI LLaMA announcement',
  'Suno AI music news',
  'Disney AI technology streaming',
  'Netflix AI technology product',
  'AI acquisition merger deal funding',
  'gaming AI news (Unity, Epic, Roblox, Activision, EA)',
  'AI startup launch funding round (up-and-coming)',
  'Apple AI news',
  'Microsoft Copilot AI news',
  'Amazon AWS AI news',
  'Nvidia AI chips hardware',
  'AI regulation policy news',
];

// Publication sources to search
const SOURCES = [
  'techcrunch.com',
  'theverge.com',
  'wired.com',
  'venturebeat.com',
  'artificialintelligence-news.com',
  'reuters.com/technology',
  'arxiv.org/list/cs.AI',
  'theinformation.com',
  'hbr.org',
  'mckinsey.com/capabilities/quantumblack',
  'technologyreview.com',
  'producthunt.com',
  'reddit.com/r/artificial',
  'nytimes.com',
];


async function fetchTopicNews(topic, apiKey) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(topic)}&tbm=nws&num=5&tbs=qdr:d&api_key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status} for "${topic}"`);
  const data = await res.json();
  return data.news_results || [];
}

async function sendAINews() {
  console.log('[ai-news] Running AI news pulse (SerpAPI + Haiku)...');

  const { signalAdapter } = require('./bot');
  const recipient = AI_NEWS_CONFIG.recipient;
  if (!recipient || !signalAdapter || !signalAdapter.ready) {
    console.warn('[ai-news] No Signal recipient or adapter not ready, skipping');
    return;
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.warn('[ai-news] SERPAPI_KEY not set, skipping news pulse');
    return;
  }

  const seen = loadSeen();

  // Fetch news for first 8 topics in parallel (rate-limit friendly)
  const topicsToFetch = TOPICS.slice(0, 8);
  const allResults = [];
  const fetchResults = await Promise.allSettled(
    topicsToFetch.map(t => fetchTopicNews(t, apiKey))
  );
  for (const r of fetchResults) {
    if (r.status === 'fulfilled') allResults.push(...r.value);
  }

  // Deduplicate by title and filter out already-seen stories
  const uniqueResults = [];
  const titlesSeen = new Set();
  for (const item of allResults) {
    if (!item.title || !item.link) continue;
    const key = item.title.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().substring(0, 60);
    if (titlesSeen.has(key)) continue;
    titlesSeen.add(key);
    const plain = item.title.substring(0, 80);
    if ([...seen].some(s => s && plain.toLowerCase().includes(s.toLowerCase().substring(0, 30)))) continue;
    uniqueResults.push(item);
  }

  if (uniqueResults.length === 0) {
    console.log('[ai-news] No new stories this cycle, not sending');
    return;
  }

  // Format with Haiku SDK
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' });
  const storiesText = uniqueResults.slice(0, 15).map(r =>
    `- ${r.title} | ${r.source?.name || 'Unknown'} | ${r.link} | ${r.date || ''}`
  ).join('\n');

  const formatPrompt = `Format these AI/tech news stories as Signal-friendly bullets. Output ONLY:
Header: **🤖 AI Pulse** — ${timeStr} PT
Then bullets (max 12): • [SourceName](url) does thing — brief detail (Xh ago)
Only the source name is hyperlinked. No raw URLs visible. No intro or outro.
If nothing notable, output: "**🤖 AI Pulse** — Nothing new since last check."

Stories:
${storiesText}`;

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: formatPrompt }],
    });
    const text = (resp.content[0]?.text || '').trim();

    if (!text || text.includes('Nothing new since last check')) {
      console.log('[ai-news] No new stories after formatting, not sending');
      return;
    }

    // Update seen list with new headlines
    for (const item of uniqueResults) {
      seen.add(item.title.substring(0, 80));
    }
    saveSeen(seen);

    await signalAdapter.sendLongMessage(recipient, text);
    const bulletCount = text.split('\n').filter(l => l.trim().startsWith('•')).length;
    console.log(`[ai-news] Sent ${bulletCount} bullets to ${recipient} (SerpAPI + Haiku, no CLI)`);
  } catch (err) {
    console.error('[ai-news] Haiku formatting failed:', err.message);
  }
}

function startAINewsScheduler() {
  if (!AI_NEWS_CONFIG.enabled) {
    console.log('[ai-news] Disabled in config');
    return;
  }

  if (!AI_NEWS_CONFIG.recipient) {
    console.warn('[ai-news] No recipient set, skipping scheduler');
    return;
  }

  schedule.scheduleJob(
    { rule: AI_NEWS_CONFIG.schedule, tz: AI_NEWS_CONFIG.timezone },
    () => sendAINews()
  );

  console.log(`[ai-news] Scheduler started: 8am–8pm every 3 hours (${AI_NEWS_CONFIG.timezone})`);
}

module.exports = { startAINewsScheduler, sendAINews, AI_NEWS_CONFIG };
