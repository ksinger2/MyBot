/**
 * Heartbeat System — periodic autonomous agent wakes (OpenClaw pattern).
 *
 * Reads AGENTS.md (standing orders) from the project root and periodically
 * wakes Claude to check if there's work to do. If nothing to do, stays silent.
 */

const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');

const heartbeats = new Map(); // channelId → { job, interval, enabled }

/**
 * Load standing orders from AGENTS.md in the project directory.
 * @param {string} cwd - Project working directory
 * @returns {string} Standing orders content, or empty string
 */
function loadStandingOrders(cwd) {
  const agentsPath = path.join(cwd, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) return '';
  try {
    const content = fs.readFileSync(agentsPath, 'utf-8').trim();
    return content.length > 6000 ? content.substring(0, 6000) + '\n...(truncated)' : content;
  } catch { return ''; }
}

/**
 * Build the heartbeat prompt — what Claude sees on each periodic wake.
 * @param {string} cwd
 * @returns {string}
 */
function buildHeartbeatPrompt(cwd) {
  const orders = loadStandingOrders(cwd);
  const nextStepsPath = path.join(cwd, 'NextSteps.md');
  let nextSteps = '';
  if (fs.existsSync(nextStepsPath)) {
    try { nextSteps = fs.readFileSync(nextStepsPath, 'utf-8').trim(); } catch {}
  }

  const parts = [
    'HEARTBEAT CHECK — You are being woken up by the heartbeat system for a periodic check.',
    'Review the standing orders and project state below. If there is work to do, do it autonomously.',
    'If there is NOTHING to do, respond with exactly: NO_ACTION_NEEDED',
    'Do NOT make small talk or filler responses. Either do real work or say NO_ACTION_NEEDED.',
  ];

  if (orders) parts.push(`\n[Standing Orders — AGENTS.md]\n${orders}`);
  if (nextSteps) parts.push(`\n[Project State — NextSteps.md]\n${nextSteps.substring(0, 4000)}`);

  return parts.join('\n');
}

/**
 * H3: detect a "no action needed" response. Tolerates the model wrapping the
 * sentinel in light markdown (`**NO_ACTION_NEEDED**`, `*NO_ACTION_NEEDED*`),
 * and only treats it as silent if the stripped result is short enough to
 * plausibly be only the sentinel — otherwise the model is reporting actual
 * work and we should forward it to the channel.
 */
function isNoActionResponse(text) {
  if (!text) return false;
  // Strip common markdown wrappers and trim whitespace
  const stripped = text.trim().replace(/^[*_`>\s]+|[*_`>\s]+$/g, '').trim();
  if (stripped === 'NO_ACTION_NEEDED') return true;
  // Allow a leading/trailing line of whitespace + the sentinel on its own line,
  // but bail if there's substantive other content (>120 chars after strip).
  if (stripped.length <= 120 && /\bNO_ACTION_NEEDED\b/.test(stripped)) {
    // Make sure removing the sentinel leaves nothing meaningful
    const remainder = stripped.replace(/\bNO_ACTION_NEEDED\b/, '').replace(/[*_`>\s.!?]+/g, '');
    return remainder.length === 0;
  }
  return false;
}

/**
 * Start a heartbeat for a channel.
 * @param {string} channelId
 * @param {object} opts
 * @param {string} opts.cwd - Project directory
 * @param {number} opts.intervalMinutes - Minutes between heartbeats (default 30)
 * @param {Function} opts.onWake - async (prompt) => result — called on each heartbeat
 * @param {Function} opts.onResult - async (result) => void — called with Claude's response
 */
function startHeartbeat(channelId, { cwd, intervalMinutes = 30, onWake, onResult }) {
  stopHeartbeat(channelId);

  // H1 + H2: per-heartbeat state for in-flight guard and error backoff.
  const hbState = {
    inFlight: false,
    consecutiveErrors: 0,
    skippedDueToInFlight: 0,
  };

  const baseIntervalMs = intervalMinutes * 60 * 1000;

  const cronRule = `*/${intervalMinutes} * * * *`;
  const job = schedule.scheduleJob(cronRule, async () => {
    // H1: skip if a previous tick is still running. Prevents overlap when a
    // single wake takes longer than the interval.
    if (hbState.inFlight) {
      hbState.skippedDueToInFlight++;
      console.log(`[heartbeat] ${channelId}: skipped (previous tick still running, skipped=${hbState.skippedDueToInFlight})`);
      return;
    }

    // H2: error backoff. After 3 consecutive failures, only run every Nth
    // tick (where N doubles up to 8x) until a success resets the counter.
    if (hbState.consecutiveErrors >= 3) {
      const skipFactor = Math.min(8, 2 ** (hbState.consecutiveErrors - 2));
      const ageMs = Date.now() - (hbState.lastAttemptMs || 0);
      if (ageMs < baseIntervalMs * skipFactor) {
        console.log(`[heartbeat] ${channelId}: backing off after ${hbState.consecutiveErrors} errors (skip factor ${skipFactor}x)`);
        return;
      }
    }

    hbState.inFlight = true;
    hbState.lastAttemptMs = Date.now();
    const prompt = buildHeartbeatPrompt(cwd);
    try {
      const result = await onWake(prompt);
      hbState.consecutiveErrors = 0;
      // H3: smarter sentinel detection — wrapper-tolerant exact match.
      if (result && result.text && !isNoActionResponse(result.text)) {
        await onResult(result);
      } else {
        console.log(`[heartbeat] ${channelId}: no action needed`);
      }
    } catch (err) {
      hbState.consecutiveErrors++;
      console.error(`[heartbeat] ${channelId} error (${hbState.consecutiveErrors} consecutive):`, err.message);
    } finally {
      hbState.inFlight = false;
    }
  });

  heartbeats.set(channelId, { job, intervalMinutes, enabled: true, cwd, state: hbState });
  console.log(`[heartbeat] Started for ${channelId}: every ${intervalMinutes}min`);
}

function stopHeartbeat(channelId) {
  const existing = heartbeats.get(channelId);
  if (existing?.job) {
    existing.job.cancel();
    heartbeats.delete(channelId);
    console.log(`[heartbeat] Stopped for ${channelId}`);
  }
}

function getHeartbeatStatus(channelId) {
  return heartbeats.get(channelId) || null;
}

function listHeartbeats() {
  const list = [];
  for (const [channelId, hb] of heartbeats) {
    list.push({ channelId, intervalMinutes: hb.intervalMinutes, enabled: hb.enabled, cwd: hb.cwd });
  }
  return list;
}

module.exports = { startHeartbeat, stopHeartbeat, getHeartbeatStatus, listHeartbeats, loadStandingOrders, buildHeartbeatPrompt };
