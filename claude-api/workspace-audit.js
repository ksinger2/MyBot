/**
 * Workspace Audit — periodic cross-workspace bug finder and fixer.
 *
 * Runs on a configurable timer from the owner DM. Each tick:
 * 1. Lists all sandbox users and their cwds
 * 2. Spawns a background Claude session per workspace (parallel)
 * 3. Each session: checks build, runs tests, lints for issues, fixes what it can
 * 4. Reports findings back to the owner DM
 */

const schedule = require('node-schedule');
const { listSandboxUsers } = require('./sandbox');

let _auditJob = null;
let _auditState = {
  inFlight: false,
  lastRun: null,
  lastResults: [],
  intervalMinutes: 60,
};

function buildAuditPrompt(sandboxName, cwd) {
  return `WORKSPACE AUDIT — You are auditing ${sandboxName}'s project at ${cwd}.

Your job:
1. Check if the project builds: look for package.json, try \`npm run build\` or equivalent
2. Run tests if they exist: \`npm test\` or similar
3. Scan for obvious bugs: broken imports, missing dependencies, syntax errors, .env misconfigs
4. Check for security issues: hardcoded secrets, exposed credentials, missing .gitignore entries
5. If you find fixable bugs, FIX THEM directly — don't just report

Output format:
- If everything is clean: "✅ ${sandboxName}: All clear — build passes, no issues found."
- If you found and fixed issues: "🔧 ${sandboxName}: Fixed N issue(s):" followed by a brief list
- If you found issues you can't fix: "⚠️ ${sandboxName}: N issue(s) need attention:" followed by a brief list

Be concise. No filler. Fix first, report second.`;
}

/**
 * Start the workspace audit timer.
 * @param {object} opts
 * @param {number} opts.intervalMinutes — minutes between audits (default 60)
 * @param {Function} opts.askClaude — async (prompt, opts) => result
 * @param {Function} opts.sendReport — async (text) => void — sends to owner DM
 * @param {object} opts.ownerState — owner DM channel state (for identity/personality)
 * @param {Function} opts.getPersonalityFile — resolves personality name to file path
 */
function startAudit({ intervalMinutes = 60, askClaude, sendReport, ownerState, getPersonalityFile }) {
  stopAudit();
  _auditState.intervalMinutes = intervalMinutes;

  const cronRule = `*/${intervalMinutes} * * * *`;
  _auditJob = schedule.scheduleJob(cronRule, async () => {
    if (_auditState.inFlight) {
      console.log('[workspace-audit] Skipping — previous audit still running');
      return;
    }

    const allUsers = listSandboxUsers();
    const sandboxEntries = Object.entries(allUsers).filter(([k]) => k !== '_groupLinks');
    if (sandboxEntries.length === 0) {
      console.log('[workspace-audit] No sandbox users — skipping');
      return;
    }

    _auditState.inFlight = true;
    _auditState.lastRun = Date.now();
    console.log(`[workspace-audit] Starting audit of ${sandboxEntries.length} workspace(s)`);

    const results = [];
    const promises = sandboxEntries.map(async ([senderId, entry]) => {
      const prompt = buildAuditPrompt(entry.name, entry.cwd);
      try {
        const result = await askClaude(prompt, {
          personalityFile: getPersonalityFile ? getPersonalityFile(ownerState?.personality) : null,
          identity: ownerState?.identity,
          cwd: entry.cwd,
          maxTurns: 15,
          channelState: null,
          model: 'sonnet',
          ownerDmMode: true,
          isOwner: true,
        });
        results.push({
          name: entry.name,
          cwd: entry.cwd,
          text: (result.text || '').substring(0, 1500),
          cost: result.cost || 0,
          numTurns: result.numTurns || 0,
          error: null,
        });
      } catch (err) {
        results.push({
          name: entry.name,
          cwd: entry.cwd,
          text: '',
          cost: 0,
          numTurns: 0,
          error: err.message,
        });
      }
    });

    await Promise.allSettled(promises);

    _auditState.inFlight = false;
    _auditState.lastResults = results;

    // Build report
    const lines = [`🔍 **Workspace Audit** — ${results.length} project(s) checked`];
    let totalCost = 0;
    for (const r of results) {
      totalCost += r.cost;
      if (r.error) {
        lines.push(`\n❌ **${r.name}** (\`${r.cwd}\`): Audit failed — ${r.error.substring(0, 200)}`);
      } else {
        lines.push(`\n${r.text}`);
      }
    }
    lines.push(`\n💰 Total audit cost: $${totalCost.toFixed(4)}`);

    const report = lines.join('\n');
    console.log(`[workspace-audit] Complete — ${results.length} workspaces, $${totalCost.toFixed(4)}`);

    try {
      await sendReport(report);
    } catch (err) {
      console.error('[workspace-audit] Failed to send report:', err.message);
    }
  });

  console.log(`[workspace-audit] Started — every ${intervalMinutes}min`);
}

function stopAudit() {
  if (_auditJob) {
    _auditJob.cancel();
    _auditJob = null;
    console.log('[workspace-audit] Stopped');
  }
}

function getAuditStatus() {
  return {
    active: !!_auditJob,
    intervalMinutes: _auditState.intervalMinutes,
    inFlight: _auditState.inFlight,
    lastRun: _auditState.lastRun,
    lastResultCount: _auditState.lastResults.length,
  };
}

module.exports = { startAudit, stopAudit, getAuditStatus };
