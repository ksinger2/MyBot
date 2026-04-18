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

function buildPrompt(seenHeadlines) {
  const seenList = seenHeadlines.size > 0
    ? `\n\nDO NOT include any of these already-seen stories (match by headline keywords):\n${[...seenHeadlines].slice(-100).map(h => `- ${h}`).join('\n')}`
    : '';

  const sourcesHint = SOURCES.length
    ? `\nPriority sources to check: ${SOURCES.join(', ')}`
    : '';

  return `You are an AI industry news scanner. Your ONLY data source is the WebSearch tool — you MUST NOT use training data or prior knowledge for news items.

STEP 1 (MANDATORY — do this FIRST, before writing anything):
Run WebSearch for EACH of these queries. You MUST call WebSearch at least 5 times with different queries:
${TOPICS.slice(0, 8).map(t => `- WebSearch("${t} ${new Date().toISOString().slice(0, 10)}")`).join('\n')}

STEP 2: From the search results, extract stories published in the last 24 hours ONLY. Ignore anything older.

RECENCY: Order NEWEST FIRST. Prioritize last 3 hours, then last 6, then last 24. Nothing older.
${sourcesHint}

FORMAT RULES (CRITICAL — follow exactly):
- Output ONLY a header and bullet points. NO intro, NO outro, NO commentary.
- Header: **🤖 AI Pulse** (then the current time in Pacific Time, e.g. "**🤖 AI Pulse** — 3:00 PM PT")
- Each bullet: hyperlink ONLY the first word (company or source name), rest of sentence is plain text, time-ago tag at end
- Format: • [CompanyName](url) does thing — brief detail (Xh ago)
- The URL is hidden — only the company/source name is clickable. DO NOT show the raw URL anywhere.
- Example: • [Meta](https://example.com) releases Llama 4 Scout — beats GPT-4o on reasoning (1h ago)
- Example: • [OpenAI](https://example.com) acquires Rockset for $800M to boost enterprise search (3h ago)
- ONLY include NEW stories not in the seen list below
- If there are zero new stories, output ONLY: "**🤖 AI Pulse** — Nothing new since last check."
- NO deep links, NO long URLs visible, NO essay, NO explanation
- Max 12 bullets. Min 0 (if nothing new).
${seenList}`;
}

async function sendAINews() {
  console.log('[ai-news] Running AI news pulse...');

  const { askClaude, signalAdapter } = require('./bot');
  const recipient = AI_NEWS_CONFIG.recipient;
  if (!recipient || !signalAdapter || !signalAdapter.ready) {
    console.warn('[ai-news] No Signal recipient or adapter not ready, skipping');
    return;
  }

  const seen = loadSeen();
  const prompt = buildPrompt(seen);

  try {
    const result = await askClaude(prompt, {
      cwd: '/app',
      maxTurns: 15, // needs multiple WebSearch calls for different topics
    });

    if (!result.text) {
      console.log('[ai-news] Empty result, skipping send');
      return;
    }

    const text = result.text.trim();
    if (text.includes('Nothing new since last check')) {
      console.log('[ai-news] No new stories this cycle, not sending');
      return;
    }

    const bulletLines = text.split('\n').filter(l => l.trim().startsWith('•') || l.trim().startsWith('-'));
    for (const line of bulletLines) {
      const plain = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[•\-\*]/g, '').trim().substring(0, 80);
      if (plain) seen.add(plain);
    }
    saveSeen(seen);

    await signalAdapter.sendLongMessage(recipient, text);
    console.log(`[ai-news] Sent ${bulletLines.length} bullets to ${recipient}`);
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

  console.log(`[ai-news] Scheduler started: 8am–8pm every 3 hours (${AI_NEWS_CONFIG.timezone})`);
}

module.exports = { startAINewsScheduler, sendAINews, AI_NEWS_CONFIG };
