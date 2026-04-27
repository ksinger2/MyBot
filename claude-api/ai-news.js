/**
 * AI News Pulse — pure RSS scraper, no AI.
 * Fetches AI/tech RSS feeds, deduplicates, formats bullet points, sends to Signal.
 */

const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');
const { SIGNAL_OWNER } = require('./project-permissions');
const { fetchFeeds, filterRecent, dedup, formatBullets } = require('./rss-fetcher');

const SEEN_FILE = path.join(__dirname, 'data', 'ai-news-seen.json');
const MAX_SEEN = 500;

const AI_NEWS_CONFIG = {
  enabled: true,
  schedule: '0 8,11,14,17,20 * * *',
  timezone: 'America/Los_Angeles',
  recipient: process.env.AI_NEWS_RECIPIENT || SIGNAL_OWNER || null,
};

const RSS_FEEDS = [
  'https://techcrunch.com/category/artificial-intelligence/feed/',
  'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
  'https://venturebeat.com/category/ai/feed/',
  'https://www.wired.com/feed/tag/ai/latest/rss',
  'https://arstechnica.com/tag/artificial-intelligence/feed/',
  'https://www.technologyreview.com/feed/',
  'https://9to5google.com/feed/',
];

const WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

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
    const arr = [...seen].slice(-MAX_SEEN);
    atomicWriteJsonSync(SEEN_FILE, arr, { spaces: 0 });
  } catch (err) {
    console.warn('[ai-news] Could not save seen file:', err.message);
  }
}

async function sendAINews() {
  console.log('[ai-news] Fetching RSS feeds...');

  const { signalAdapter } = require('./bot');
  const recipient = AI_NEWS_CONFIG.recipient;
  if (!recipient || !signalAdapter || !signalAdapter.ready) {
    console.warn('[ai-news] No Signal recipient or adapter not ready, skipping');
    return;
  }

  const seen = loadSeen();

  try {
    const allItems = await fetchFeeds(RSS_FEEDS);
    console.log(`[ai-news] Fetched ${allItems.length} total items from ${RSS_FEEDS.length} feeds`);

    const recent = filterRecent(allItems, WINDOW_MS);
    const fresh = dedup(recent, seen);

    // Add new items to seen set
    for (const item of fresh) {
      seen.add(item._dedupKey);
    }
    saveSeen(seen);

    if (fresh.length === 0) {
      console.log('[ai-news] No new stories this cycle');
      return;
    }

    const text = formatBullets(fresh, {
      header: 'AI Pulse',
      emoji: '🤖',
      maxBullets: 12,
    });

    await signalAdapter.sendLongMessage(recipient, text);
    console.log(`[ai-news] Sent ${Math.min(fresh.length, 12)} bullets to ${recipient}`);
  } catch (err) {
    console.error('[ai-news] Failed:', err.message);
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

  console.log(`[ai-news] Scheduler started: 8am–8pm every 3 hours (${AI_NEWS_CONFIG.timezone}) [RSS mode]`);
}

module.exports = { startAINewsScheduler, sendAINews, AI_NEWS_CONFIG };
