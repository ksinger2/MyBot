'use strict';

const fs = require('fs');
const path = require('path');

const AUTONOMOUS_STATE_FILE = '/app/data/autonomous-state.json';
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_DAILY_COST_USD = 5.0;
const MAX_DAILY_ITERATIONS = 20;

function _loadState() {
  try { return JSON.parse(fs.readFileSync(AUTONOMOUS_STATE_FILE, 'utf8')); }
  catch { return { enabled: false, iterationsToday: 0, costToday: 0, lastDate: null, lastRunAt: null }; }
}

function _saveState(s) {
  fs.writeFileSync(AUTONOMOUS_STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function _resetDailyCounters(s) {
  const today = new Date().toISOString().slice(0, 10);
  if (s.lastDate !== today) {
    s.iterationsToday = 0;
    s.costToday = 0;
    s.lastDate = today;
  }
}

function buildAutonomousPrompt(cwd) {
  const parts = ['AUTONOMOUS IMPROVEMENT MODE\n'];
  const nextStepsPath = path.join(cwd, 'NextSteps.md');
  try {
    const ns = fs.readFileSync(nextStepsPath, 'utf8');
    parts.push(`<next-steps>\n${ns.slice(0, 3000)}\n</next-steps>`);
  } catch {}

  parts.push(`Review the current state of the project. Check NextSteps.md for pending work and known issues.

Decide what to do:
1. If there are broken items or bugs in "What's Broken", fix the highest-priority one.
2. If everything is working, look at "Next Steps" and tackle the top item.
3. If nothing needs doing, respond with exactly "NO_ACTION_NEEDED" and stop.

Rules:
- Fix ONE thing per iteration. Do not try to fix everything at once.
- Run tests after any code change.
- Update NextSteps.md with what you did.
- Do NOT emit [REBUILD] — code changes only, committed to git.
- NEVER retry a failed approach more than twice.
- After completing the fix, STOP.`);

  return parts.join('\n\n');
}

let _autonomousTimer = null;

function startAutonomous(runFn) {
  const s = _loadState();
  s.enabled = true;
  _saveState(s);
  _scheduleNext(runFn);
}

function stopAutonomous() {
  if (_autonomousTimer) {
    clearTimeout(_autonomousTimer);
    _autonomousTimer = null;
  }
  const s = _loadState();
  s.enabled = false;
  _saveState(s);
}

function _scheduleNext(runFn) {
  if (_autonomousTimer) clearTimeout(_autonomousTimer);
  _autonomousTimer = setTimeout(() => _runIteration(runFn), DEFAULT_INTERVAL_MS);
}

let _iterationRunning = false;

async function _runIteration(runFn) {
  _autonomousTimer = null;
  const s = _loadState();
  if (!s.enabled) return;

  // Guard against overlapping iterations (previous one still running)
  if (_iterationRunning) {
    console.log('[autonomous] Previous iteration still running — skipping this cycle');
    _scheduleNext(runFn);
    return;
  }

  _resetDailyCounters(s);

  if (s.iterationsToday >= MAX_DAILY_ITERATIONS) {
    console.log(`[autonomous] Daily iteration cap reached (${MAX_DAILY_ITERATIONS})`);
    _scheduleNext(runFn);
    return;
  }

  s.iterationsToday++;
  s.lastRunAt = new Date().toISOString();
  _saveState(s);

  _iterationRunning = true;
  try {
    console.log(`[autonomous] Starting iteration ${s.iterationsToday}/${MAX_DAILY_ITERATIONS}`);
    await runFn();
  } catch (err) {
    console.error(`[autonomous] Iteration error: ${err.message}`);
  } finally {
    _iterationRunning = false;
  }

  // Re-check enabled state — may have been stopped while iteration was running
  const current = _loadState();
  if (current.enabled) {
    _scheduleNext(runFn);
  }
}

module.exports = {
  name: '!autonomous',
  aliases: ['!auto-improve'],
  adminOnly: true,
  description: 'Toggle autonomous self-improvement. `!autonomous start|stop|status`.',
  async run(message, arg, state, ctx) {
    const sub = (arg || '').trim().toLowerCase();

    if (sub === 'start') {
      const cwd = state.cwd || '/workspace/MyBot';
      const personalityFile = ctx.getPersonalityFile(state.personality);

      const runFn = async () => {
        // Don't start an autonomous iteration if the channel is busy
        if (state.busy) {
          console.log('[autonomous] Channel is busy — skipping this cycle');
          return;
        }
        const prompt = buildAutonomousPrompt(cwd);
        state.busy = true;
        try {
          const result = await ctx.runClaudeWithContinuation(prompt, {
            personalityFile,
            identity: state.identity,
            cwd,
            channelState: state,
          }, null);
          const text = result?.text || '';
          if (text.includes('NO_ACTION_NEEDED')) {
            console.log('[autonomous] No action needed this cycle');
          } else {
            const summary = text.length > 300 ? text.slice(0, 300) + '...' : text;
            await message.reply(`[Autonomous] Completed iteration:\n${summary}`).catch(() => {});
          }
        } catch (err) {
          console.error(`[autonomous] Error: ${err.message}`);
        } finally {
          state.busy = false;
        }
      };

      startAutonomous(runFn);
      await message.reply(`Autonomous mode started. Will check every ${DEFAULT_INTERVAL_MS / 60000} minutes. Max ${MAX_DAILY_ITERATIONS} iterations/day. Use \`!autonomous stop\` to disable.`);
    } else if (sub === 'stop') {
      stopAutonomous();
      await message.reply('Autonomous mode stopped.');
    } else if (sub === 'status') {
      const s = _loadState();
      _resetDailyCounters(s);
      await message.reply(`**Autonomous mode**: ${s.enabled ? 'ACTIVE' : 'STOPPED'}\nIterations today: ${s.iterationsToday}/${MAX_DAILY_ITERATIONS}\nLast run: ${s.lastRunAt || 'never'}\nTimer active: ${_autonomousTimer ? 'yes' : 'no'}`);
    } else {
      await message.reply('Usage: `!autonomous start|stop|status`');
    }
  },
};
