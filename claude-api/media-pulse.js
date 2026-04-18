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
  const { askClaude, signalAdapter } = require('./bot');
  const isSignal = typeof sched.userId === 'string' && sched.userId.startsWith('+');

  const seen = loadSeen();
  const prompt = buildPromptWithSeen(sched.message, seen);

  console.log(`[media-pulse] Running job #${sched.id} (${seen.size} seen in dedup list)`);

  const result = await askClaude(prompt, {
    cwd: '/app',
    maxTurns: 10,
  });

  if (!result.text) {
    console.log(`[media-pulse] Job #${sched.id} returned no text`);
    return;
  }

  const text = result.text.trim();
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
