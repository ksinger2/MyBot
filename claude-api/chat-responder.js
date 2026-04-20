'use strict';
/**
 * chat-responder.js — SDK fast-path for non-owner Signal DMs.
 *
 * Routes casual conversational messages to Haiku via the Anthropic SDK
 * directly, avoiding the cost + latency of spawning the full Claude CLI.
 * If Haiku replies with `[NEEDS_AGENT]`, returns null so the caller can
 * fall through to the full CLI runner.
 *
 * History is kept per-channel in memory (capped at MAX_HISTORY_PAIRS turns)
 * and is cleared when the user runs `!clear`.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('./system-prompt');

const _histories = new Map(); // channelId → [{role, content}, ...]
const MAX_HISTORY_PAIRS = 10;

async function chatRespond({ channelId, userText, identity, personalityFile, profileContext, isGroupChat = false }) {
  const client = new Anthropic(); // uses ANTHROPIC_API_KEY from env

  if (!_histories.has(channelId)) _histories.set(channelId, []);
  const history = _histories.get(channelId);

  const systemPrompt = buildSystemPrompt({ identity, personalityFile, readOnly: true, isGroupChat });

  // Inject current date so relative expressions ("tonight", "next Friday") resolve correctly.
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles',
  });
  const dateContext = `Today is ${dateStr}, ${timeStr} PT.`;

  // Build messages: inject profile context + date at start of fresh history
  let messages;
  if (history.length === 0 && profileContext) {
    messages = [
      { role: 'user', content: `${dateContext}\n\n${profileContext}` },
      { role: 'assistant', content: 'Got it.' },
      { role: 'user', content: userText },
    ];
  } else {
    // Always prepend date to the current user message so it's never stale
    messages = [...history, { role: 'user', content: `${dateContext}\n\n${userText}` }];
  }

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    system: systemPrompt,
    messages,
  });

  const text = (resp.content[0]?.text || '').trim();
  // Escalate to CLI if the response contains any action tag — these require
  // bot infrastructure and cannot be processed by the SDK fast-path.
  // Explicit allowlist (not a shape regex) to avoid false-positives on
  // normal text like [NOTE:], [ERROR:], [UPDATE:], etc.
  const ACTION_TAG_RE = /\[(NEEDS_AGENT|IMAGINE|REMIND|EVENT|EVENT_JOIN|CALENDAR|WEATHER|EIGHTSLEEP|PRODUCT|SET_PREF|LEARNED|UPDATE_NOTES|REBUILD|FLIGHT|CONCERT_PRICES)[:\]]/;
  if (!text || ACTION_TAG_RE.test(text)) return null;

  // Update history, trim to MAX_HISTORY_PAIRS
  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: text });
  while (history.length > MAX_HISTORY_PAIRS * 2) history.splice(0, 2);

  return text;
}

function clearHistory(channelId) {
  _histories.delete(channelId);
}

module.exports = { chatRespond, clearHistory };
