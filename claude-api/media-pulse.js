/**
 * Media Pulse — pure RSS scraper, no AI.
 * Fetches media/entertainment RSS feeds, deduplicates, formats bullet points.
 * Dispatched from scheduler.js when `sched.subtype === 'media-pulse'`.
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');
const { fetchFeeds, filterRecent, dedup, formatBullets } = require('./rss-fetcher');

const SEEN_FILE = path.join(__dirname, 'data', 'media-pulse-seen.json');
const MAX_SEEN = 500;

const RSS_FEEDS = [
  'https://variety.com/feed/',
  'https://deadline.com/feed/',
  'https://www.thewrap.com/feed/',
  'https://www.hollywoodreporter.com/feed/',
  'https://techcrunch.com/category/media-entertainment/feed/',
];

const WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

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
    console.warn('[media-pulse] Could not save seen file:', err.message);
  }
}

async function runMediaPulseJob(sched) {
  const { signalAdapter } = require('./bot');
  const isSignal = typeof sched.userId === 'string' && sched.userId.startsWith('+');

  console.log(`[media-pulse] Running job #${sched.id} [RSS mode]`);

  const seen = loadSeen();

  try {
    const allItems = await fetchFeeds(RSS_FEEDS);
    console.log(`[media-pulse] Fetched ${allItems.length} total items from ${RSS_FEEDS.length} feeds`);

    const recent = filterRecent(allItems, WINDOW_MS);
    const fresh = dedup(recent, seen);

    for (const item of fresh) {
      seen.add(item._dedupKey);
    }
    saveSeen(seen);

    if (fresh.length === 0) {
      console.log('[media-pulse] No new stories this cycle');
      return;
    }

    const text = formatBullets(fresh, {
      header: 'Media Pulse',
      emoji: '📺',
      maxBullets: 12,
    });

    if (isSignal) {
      if (signalAdapter && signalAdapter.ready) {
        await signalAdapter.sendLongMessage(sched.userId, text);
        console.log(`[media-pulse] Job #${sched.id} sent ${Math.min(fresh.length, 12)} bullets to Signal DM`);
      } else {
        console.warn(`[media-pulse] Job #${sched.id} — Signal adapter not ready, skipping`);
      }
    } else {
      console.warn(`[media-pulse] Job #${sched.id} — non-Signal userId "${sched.userId}" not supported yet`);
    }
  } catch (err) {
    console.error(`[media-pulse] Job #${sched.id} failed:`, err.message);
  }
}

module.exports = { runMediaPulseJob, loadSeen, saveSeen };
