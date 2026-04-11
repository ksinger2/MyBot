/**
 * AI News Pulse — every 3 hours
 * Searches for new AI industry news and sends bullet-point TLDRs to Discord.
 * Deduplicates across cycles so you only see new stories each time.
 */

const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');
const { atomicWriteJsonSync } = require('./atomic-write');

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
  schedule: '0 8,11,14,17 * * *',
  timezone: 'America/Los_Angeles',
  channelId: '1481550166501626039', // same channel as morning briefing
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

  return `You are an AI industry news scanner. Your job: find the LATEST AI news, prioritizing RECENCY above all else.

RECENCY RULES (CRITICAL):
- STRONGLY PRIORITIZE stories published in the last 3 hours
- Include stories up to 6 hours old only if highly significant
- IGNORE anything older than 24 hours — it's stale
- Order results NEWEST FIRST, then by importance within the same time window

USE WEB SEARCH to find real, current stories. Search these topics:
${TOPICS.map(t => `- "${t}"`).join('\n')}
${sourcesHint}

FORMAT RULES (CRITICAL — follow exactly):
- Output ONLY a header and bullet points. NO intro, NO outro, NO commentary.
- Header: **🤖 AI Pulse** (then the current time in Pacific Time, e.g. "**🤖 AI Pulse** — 3:00 PM PT")
- Each bullet: one sentence, max ~15 words, ONE hyperlinked word, and a time-ago tag at the end
- Hyperlink format: [word](url) — pick the most descriptive word (company name, product, or key action)
- Time-ago format: parenthetical at end of bullet showing when published
- Example: • Meta [releases](https://example.com) Llama 4 Scout — beats GPT-4o on reasoning (1h ago)
- Example: • OpenAI [acquires](https://example.com) Rockset for $800M to boost enterprise search (3h ago)
- ONLY include NEW stories not in the seen list below
- If there are zero new stories, output ONLY: "**🤖 AI Pulse** — Nothing new since last check."
- NO deep links, NO long URLs visible, NO essay, NO explanation
- Max 12 bullets. Min 0 (if nothing new).
${seenList}`;
}

async function sendAINews(client) {
  console.log('[ai-news] Running AI news pulse...');

  const channel = await client.channels.fetch(AI_NEWS_CONFIG.channelId).catch(() => null);
  if (!channel) {
    console.error('[ai-news] Cannot access channel', AI_NEWS_CONFIG.channelId);
    return;
  }

  const seen = loadSeen();
  const prompt = buildPrompt(seen);

  const { askClaude } = require('./bot');

  try {
    const result = await askClaude(prompt, {
      cwd: '/app',
      maxTurns: 5,
    });

    if (!result.text) {
      console.log('[ai-news] Empty result, skipping send');
      return;
    }

    const text = result.text.trim();

    // If nothing new, skip sending
    if (text.includes('Nothing new since last check')) {
      console.log('[ai-news] No new stories this cycle, not sending');
      return;
    }

    // Extract new headlines to add to seen set
    const bulletLines = text.split('\n').filter(l => l.trim().startsWith('•') || l.trim().startsWith('-'));
    for (const line of bulletLines) {
      // Extract the plain text of the bullet as the dedup key
      const plain = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[•\-\*]/g, '').trim().substring(0, 80);
      if (plain) seen.add(plain);
    }
    saveSeen(seen);

    // Send to Discord with embeds suppressed (no link previews)
    const sendOpts = (content) => ({ content, flags: [MessageFlags.SuppressEmbeds] });

    if (text.length <= 1900) {
      await channel.send(sendOpts(text));
    } else {
      // Split on newlines if too long
      const chunks = [];
      let remaining = text;
      while (remaining.length > 0) {
        if (remaining.length <= 1900) { chunks.push(remaining); break; }
        let splitAt = remaining.lastIndexOf('\n', 1900);
        if (splitAt < 500) splitAt = 1900;
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt);
      }
      for (const chunk of chunks.slice(0, 6)) {
        await channel.send(sendOpts(chunk));
      }
    }

    console.log(`[ai-news] Sent ${bulletLines.length} bullets to #${channel.name || AI_NEWS_CONFIG.channelId}`);
  } catch (err) {
    console.error('[ai-news] Failed:', err.message);
  }
}

function startAINewsScheduler(client) {
  if (!AI_NEWS_CONFIG.enabled) {
    console.log('[ai-news] Disabled in config');
    return;
  }

  if (!AI_NEWS_CONFIG.channelId) {
    console.warn('[ai-news] No channelId set, skipping scheduler');
    return;
  }

  schedule.scheduleJob(
    { rule: AI_NEWS_CONFIG.schedule, tz: AI_NEWS_CONFIG.timezone },
    () => sendAINews(client)
  );

  console.log(`[ai-news] Scheduler started: every 3 hours (${AI_NEWS_CONFIG.timezone})`);
}

module.exports = { startAINewsScheduler, sendAINews, AI_NEWS_CONFIG };
