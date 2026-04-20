/**
 * Media Pulse typed handler — deduplicates across cycles.
 *
 * Why this exists: before, Media Pulse ran via the generic dm-task path
 * (scheduler.js → askClaude(sched.message)). With a 5-hour window and
 * no memory of what was already sent, each cycle kept re-surfacing the
 * same stories. This module augments the prompt with a seen list and
 * captures new headlines after each run — same pattern as ai-news.js.
 *
 * Dispatched from scheduler.js when `sched.subtype === 'media-pulse'`.
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

// /app/data is a mounted docker volume so the seen list survives rebuilds
const SEEN_FILE = path.join(__dirname, 'data', 'media-pulse-seen.json');
const MAX_SEEN = 500;

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

function buildPromptWithSeen(basePrompt, seen) {
  if (seen.size === 0) return basePrompt;
  const seenList = [...seen].slice(-120).map(h => `- ${h}`).join('\n');
  return `${basePrompt}\n\nDO NOT include any of these already-sent stories (match by headline keywords, ignore minor wording differences):\n${seenList}`;
}

async function runMediaPulseJob(sched) {
  const { signalAdapter } = require('./bot');
  const isSignal = typeof sched.userId === 'string' && sched.userId.startsWith('+');

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.warn(`[media-pulse] SERPAPI_KEY not set, skipping job #${sched.id}`);
    return;
  }

  const seen = loadSeen();
  console.log(`[media-pulse] Running job #${sched.id} via SerpAPI (${seen.size} seen in dedup list)`);

  // Extract a search query from the schedule message (use first 100 chars as query)
  const query = sched.message.replace(/\[.*?\]/g, '').trim().substring(0, 100);
  let allResults = [];
  try {
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&tbm=nws&num=10&tbs=qdr:d&api_key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      const data = await res.json();
      allResults = data.news_results || [];
    }
  } catch (err) {
    console.warn(`[media-pulse] SerpAPI fetch failed: ${err.message}`);
    return;
  }

  // Filter out already-seen stories
  const newResults = allResults.filter(item => {
    if (!item.title) return false;
    const plain = item.title.substring(0, 80);
    return ![...seen].some(s => s && plain.toLowerCase().includes(s.toLowerCase().substring(0, 30)));
  });

  if (newResults.length === 0) {
    console.log(`[media-pulse] Job #${sched.id} — no new stories, skipping`);
    return;
  }

  // Format with Haiku SDK
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const storiesText = newResults.slice(0, 12).map(r =>
    `- ${r.title} | ${r.source?.name || 'Unknown'} | ${r.link} | ${r.date || ''}`
  ).join('\n');

  const seenList = seen.size > 0
    ? `\n\nDO NOT repeat these already-sent stories:\n${[...seen].slice(-60).map(h => `- ${h}`).join('\n')}`
    : '';

  const formatPrompt = `${sched.message}\n\nFRESH NEWS TO FORMAT (from today):\n${storiesText}${seenList}

Format as bullet points. If using markdown links, only hyperlink the source name. No raw URLs visible. Keep it concise.
If nothing notable, output: "Nothing new since last check."`;

  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{ role: 'user', content: formatPrompt }],
  });
  const text = (resp.content[0]?.text || '').trim();
  if (text.includes('Nothing new since last check')) {
    console.log('[media-pulse] No new stories this cycle, not sending');
    return;
  }

  // Capture new bullet headlines so next cycle knows not to repeat them
  const bulletLines = text.split('\n').filter(l => {
    const t = l.trim();
    return t.startsWith('•') || t.startsWith('-');
  });
  for (const line of bulletLines) {
    const plain = line
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[•\-\*]/g, '')
      .trim()
      .substring(0, 80);
    if (plain) seen.add(plain);
  }
  saveSeen(seen);

  if (isSignal) {
    if (signalAdapter && signalAdapter.ready) {
      await signalAdapter.sendLongMessage(sched.userId, text);
      console.log(`[media-pulse] Job #${sched.id} sent to Signal DM (${bulletLines.length} bullets)`);
    } else {
      console.warn(`[media-pulse] Job #${sched.id} — Signal adapter not ready, skipping`);
    }
  } else {
    console.warn(`[media-pulse] Job #${sched.id} — non-Signal userId "${sched.userId}" not supported yet`);
  }
}

module.exports = { runMediaPulseJob, loadSeen, saveSeen };
