const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code: err?.code });
    });
  });
}

async function runDiagnostics() {
  const checks = [];

  const compose = await exec('docker', ['compose', 'ps', '--format', '{{.Name}}\t{{.Status}}']);
  if (compose.ok) {
    const lines = compose.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      const [name, ...rest] = line.split('\t');
      const status = rest.join('\t');
      const healthy = /healthy/i.test(status);
      const up = /Up/i.test(status);
      if (!up) checks.push({ level: 'critical', msg: `${name}: DOWN (${status})` });
      else if (!healthy) checks.push({ level: 'warn', msg: `${name}: up but not healthy (${status})` });
    }
    if (lines.length === 0) checks.push({ level: 'critical', msg: 'No containers found' });
  } else {
    checks.push({ level: 'critical', msg: `docker compose ps failed: ${compose.stderr || compose.code}` });
  }

  const signal = await exec('docker', ['exec', 'mybot-signal-api-1', 'curl', '-sf', 'http://localhost:8080/v1/about']);
  if (!signal.ok) checks.push({ level: 'critical', msg: 'signal-api /v1/about unreachable' });

  const bot = await exec('docker', ['exec', 'mybot-claude-api-1', 'curl', '-sf', 'http://localhost:3400/health']);
  if (!bot.ok) checks.push({ level: 'critical', msg: 'claude-api /health unreachable' });

  const df = await exec('docker', ['exec', 'mybot-claude-api-1', 'df', '-h', '/']);
  if (df.ok) {
    const match = df.stdout.match(/(\d+)%/);
    if (match && parseInt(match[1]) > 90) {
      checks.push({ level: 'warn', msg: `Disk usage at ${match[1]}%` });
    }
  }

  const logs = await exec('docker', ['compose', 'logs', '--tail', '30', 'claude-api']);
  const errorLines = (logs.stdout || '').split('\n').filter(l => /error|fatal|uncaught|ECONNREFUSED/i.test(l));
  if (errorLines.length > 5) {
    checks.push({ level: 'warn', msg: `${errorLines.length} error lines in recent claude-api logs` });
  }

  const restarts = await exec('docker', ['inspect', 'mybot-claude-api-1', '--format', '{{.RestartCount}}']);
  if (restarts.ok && parseInt(restarts.stdout) > 3) {
    checks.push({ level: 'warn', msg: `claude-api has restarted ${restarts.stdout} times` });
  }

  return checks;
}

module.exports = {
  name: '!repair',
  aliases: ['!fix', '!diagnose', '!diag'],
  adminOnly: true,
  description: 'Self-diagnose and repair -- run from phone when something is wrong',
  async run(message, arg, state, ctx) {
    await ctx._sreply(message, 'Running diagnostics...');

    const checks = await runDiagnostics();
    const critical = checks.filter(c => c.level === 'critical');
    const warnings = checks.filter(c => c.level === 'warn');

    if (checks.length === 0) {
      await ctx._sreply(message, 'All systems healthy. Containers up, signal-api reachable, health endpoint OK, disk fine.');
      if (!arg) return;
    }

    let report = '';
    if (critical.length) report += 'CRITICAL:\n' + critical.map(c => `- ${c.msg}`).join('\n') + '\n';
    if (warnings.length) report += 'WARNINGS:\n' + warnings.map(c => `- ${c.msg}`).join('\n') + '\n';

    if (checks.length > 0) {
      await ctx._sreply(message, report.trim());
    }

    if (arg === 'check') return;

    if (critical.length > 0 || arg) {
      const prompt = arg
        ? `The user asked you to repair/fix: ${arg}`
        : `Self-repair needed. Diagnostics found these issues:\n${report}\nInvestigate and fix what you can. Run docker compose commands if containers need restarting. Check logs for root causes. Report what you fixed and what needs manual attention.`;

      if (state.busy) {
        await ctx._sreply(message, 'Already working on something. Use !stop first, then !repair again.');
        return;
      }

      await ctx._sreply(message, 'Kicking off Claude to investigate and fix...');
      state.busy = true;
      state.startedAt = Date.now();
      state.progress = ctx.freshProgress();

      const typingInterval = setInterval(() => { ctx._styping(message).catch(() => {}); }, 8000);
      const personalityFile = ctx.getPersonalityFile(state.personality);

      try {
        const result = await ctx.askClaude(prompt, {
          sessionId: state.sessionId,
          personalityFile,
          identity: state.identity,
          cwd: state.cwd,
          maxTurns: 30,
          channelState: state,
        });

        if (result.sessionId) state.sessionId = result.sessionId;
        if (!result.stopped) {
          await ctx.sendLongMessage(message, result.text, state.cwd);
        }
      } catch (err) {
        const errorMsg = err.message.length > 300 ? err.message.substring(0, 300) + '...' : err.message;
        await ctx._sreply(message, `Repair error: ${errorMsg}`);
        ctx.sendErrorAlert(err, { source: 'repair command', channel: message.channel.id });
      } finally {
        clearInterval(typingInterval);
        state.busy = false;
        state.startedAt = null;
        state.progress = ctx.freshProgress();
      }
    }
  }
};
