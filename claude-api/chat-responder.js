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
const MAX_HISTORY_PAIRS = 6;
const FASTPATH_MODEL = process.env.NON_OWNER_FASTPATH_MODEL || 'claude-haiku-4-5-20251001';
const FASTPATH_MAX_TOKENS = parseInt(process.env.NON_OWNER_FASTPATH_MAX_TOKENS, 10) || 250;
const MAX_PROFILE_CONTEXT_CHARS = parseInt(process.env.NON_OWNER_PROFILE_CONTEXT_MAX_CHARS, 10) || 1400;
const MAX_USER_TEXT_CHARS = parseInt(process.env.NON_OWNER_FASTPATH_INPUT_MAX_CHARS, 10) || 2500;

function trimText(text, maxChars) {
  if (!text || typeof text !== 'string') return '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

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
  const trimmedUserText = trimText(userText, MAX_USER_TEXT_CHARS);
  const trimmedProfileContext = trimText(profileContext, MAX_PROFILE_CONTEXT_CHARS);

  let messages;
  if (history.length === 0 && trimmedProfileContext) {
    messages = [
      { role: 'user', content: `${dateContext}\n\n${trimmedProfileContext}` },
      { role: 'assistant', content: 'Got it.' },
      { role: 'user', content: trimmedUserText },
    ];
  } else {
    // Always prepend date to the current user message so it's never stale
    messages = [...history, { role: 'user', content: `${dateContext}\n\n${trimmedUserText}` }];
  }

  const resp = await client.messages.create({
    model: FASTPATH_MODEL,
    max_tokens: FASTPATH_MAX_TOKENS,
    system: systemPrompt,
    messages,
  });

  const text = (resp.content[0]?.text || '').trim();
  // Escalate to CLI if the response contains any action tag — these require
  // bot infrastructure and cannot be processed by the SDK fast-path.
  // Explicit allowlist (not a shape regex) to avoid false-positives on
  // normal text like [NOTE:], [ERROR:], [UPDATE:], etc.
  // Only escalate to CLI for true [NEEDS_AGENT] (complex multi-step task).
  // All other action tags ([EVENT:], [REMIND:], [IMAGINE:], etc.) are handled
  // by bot.js post-processing via the synthetic result object — no CLI needed.
  if (!text || /\[NEEDS_AGENT\]/.test(text)) return null;

  // Update history, trim to MAX_HISTORY_PAIRS
  history.push({ role: 'user', content: trimmedUserText });
  history.push({ role: 'assistant', content: text });
  while (history.length > MAX_HISTORY_PAIRS * 2) history.splice(0, 2);

  return text;
}

function clearHistory(channelId) {
  _histories.delete(channelId);
}

module.exports = { chatRespond, clearHistory };
