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

  const cronRule = `*/${intervalMinutes} * * * *`;
  const job = schedule.scheduleJob(cronRule, async () => {
    const prompt = buildHeartbeatPrompt(cwd);
    try {
      const result = await onWake(prompt);
      if (result && result.text && !result.text.includes('NO_ACTION_NEEDED')) {
        await onResult(result);
      } else {
        console.log(`[heartbeat] ${channelId}: no action needed`);
      }
    } catch (err) {
      console.error(`[heartbeat] ${channelId} error:`, err.message);
    }
  });

  heartbeats.set(channelId, { job, intervalMinutes, enabled: true, cwd });
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
