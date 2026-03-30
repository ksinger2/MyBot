const { execFileSync } = require('child_process');

/**
 * GitHub CI Poller — checks for new workflow failures via `gh` CLI
 */
async function pollGitHubCI(monitor) {
  const repo = monitor.config.repo;
  if (!repo) return { changed: false };

  // Validate repo format to prevent injection (owner/repo only)
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
    console.error(`[poller] Invalid repo format: ${repo}`);
    return { changed: false };
  }

  const args = ['run', 'list', '--repo', repo, '--limit', '5',
    '--json', 'status,conclusion,name,headBranch,url,databaseId,updatedAt'];
  if (monitor.config.branch) {
    if (!/^[a-zA-Z0-9._\/-]+$/.test(monitor.config.branch)) {
      console.error(`[poller] Invalid branch format: ${monitor.config.branch}`);
      return { changed: false };
    }
    args.push('--branch', monitor.config.branch);
  }

  let runs;
  try {
    const output = execFileSync('gh', args, { encoding: 'utf-8', timeout: 15000 });
    runs = JSON.parse(output);
  } catch (err) {
    console.error(`[poller] gh run list failed for ${repo}:`, err.message);
    return { changed: false };
  }

  const failed = runs.filter(r => r.conclusion === 'failure');

  // Check for recovery — was failing, now all passing
  const lastSeenIds = monitor.lastState?.failedIds || [];
  if (failed.length === 0 && lastSeenIds.length > 0) {
    return {
      changed: true,
      summary: `✅ ${repo} CI is back to green!`,
      prompt: null,
      dedupKey: `ci:${repo}:recovered`,
      newState: { failedIds: [] },
    };
  }

  if (failed.length === 0) return { changed: false };

  // Detect NEW failures only
  const newFailures = failed.filter(f => !lastSeenIds.includes(f.databaseId));
  if (newFailures.length === 0) return { changed: false };

  const summary = newFailures.map(f => `❌ ${f.name} failed on ${f.headBranch}`).join('\n');
  const prompt = `GitHub Actions failures detected in ${repo}:\n${newFailures.map(f =>
    `- Workflow "${f.name}" failed on branch ${f.headBranch}. URL: ${f.url}`
  ).join('\n')}\n\nCheck the logs with \`gh run view ${newFailures[0].databaseId} --repo ${repo} --log-failed\`, diagnose the issue, and fix it.`;

  return {
    changed: true,
    summary,
    prompt,
    dedupKey: `ci:${repo}:${newFailures.map(f => f.databaseId).join(',')}`,
    newState: { failedIds: failed.map(f => f.databaseId) },
  };
}

/**
 * URL Health Poller — simple HTTP status check
 */
async function pollURLHealth(monitor) {
  const url = monitor.config.url;
  if (!url) return { changed: false };

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const isHealthy = resp.status === (monitor.config.expectStatus || 200);
    const wasHealthy = monitor.lastState?.healthy !== false;

    if (isHealthy && wasHealthy) return { changed: false };
    if (!isHealthy && !wasHealthy) return { changed: false }; // still down, already notified

    const summary = isHealthy
      ? `✅ ${url} is back up (status ${resp.status})`
      : `🔴 ${url} is DOWN (status ${resp.status})`;
    const prompt = !isHealthy
      ? `Health check failed for ${url} (got ${resp.status}, expected ${monitor.config.expectStatus || 200}). Investigate — check docker logs, service status, and try to fix.`
      : null; // no prompt needed for recovery

    return {
      changed: true,
      summary,
      prompt,
      dedupKey: `health:${url}:${isHealthy}`,
      newState: { healthy: isHealthy },
    };
  } catch (err) {
    // Connection error = down
    if (monitor.lastState?.healthy === false) return { changed: false };
    return {
      changed: true,
      summary: `🔴 ${url} unreachable: ${err.message}`,
      prompt: `Health check for ${url} failed with connection error: ${err.message}. Investigate and fix.`,
      dedupKey: `health:${url}:down`,
      newState: { healthy: false },
    };
  }
}

module.exports = { pollGitHubCI, pollURLHealth };
