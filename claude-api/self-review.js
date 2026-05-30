'use strict';

/**
 * self-review.js — Adversarial self-review and QA gate for agent workflows.
 *
 * Two exports:
 *   buildSelfReviewPrompt(taskDescription) — returns a prompt string
 *   runQAGate(askClaudeFn, cwd, taskDescription) — runs a read-only QA pass
 */

/**
 * Build an adversarial self-review prompt that instructs Claude to audit
 * its own recent work: read the diff, hunt for bugs, run tests, fix issues.
 *
 * @param {string} taskDescription — human-readable description of what was built
 * @returns {string} prompt text
 */
function buildSelfReviewPrompt(taskDescription) {
  if (!taskDescription || typeof taskDescription !== 'string') {
    taskDescription = 'the most recent changes';
  }

  return `# SELF-REVIEW MODE — Adversarial Code Audit

You just completed the following task: "${taskDescription}"

Now act as a **hostile code reviewer** whose only goal is to find bugs, regressions, and security issues in your own work. Follow these steps in order:

## Step 1: Read the diff

Run \`git diff HEAD~1\` to see what changed. If there are uncommitted changes, also run \`git diff\` to catch those.

For EACH changed file, scrutinize line-by-line for:
- **Off-by-one errors** — loop bounds, array indexing, string slicing
- **Missing null/undefined checks** — any property access on a value that could be nullish
- **Broken imports** — require/import paths that don't resolve, missing dependencies
- **Hardcoded values** — magic numbers, localhost URLs, absolute paths that should be configurable
- **Security issues** — unsanitized input, secrets in code, eval(), shell injection, path traversal
- **Edge cases** — empty arrays, empty strings, zero, negative numbers, very large inputs
- **Error handling** — swallowed errors, missing try/catch around async calls, unhelpful error messages
- **Race conditions** — concurrent access to shared state without synchronization
- **Resource leaks** — unclosed file handles, timers without cleanup, event listeners without removal

## Step 2: Run the test suite

Run the project's test suite:
\`\`\`
npm test || node --test tests/*.test.js
\`\`\`

If tests fail:
1. Read the test output carefully
2. Determine if the failure is in your new code or a pre-existing issue
3. If caused by your changes, **fix the failing tests immediately**
4. Re-run to confirm the fix

## Step 3: Fix bugs found

If you found bugs in Step 1:
1. List each bug with file, line, and description
2. Fix each one
3. Re-run tests after fixes to confirm no regressions

## Step 4: Report

Summarize what you found and fixed in this format:

**Bugs found:** <count>
**Bugs fixed:** <count>
**Tests:** PASS / FAIL (with details if FAIL)
**Files reviewed:** <list>
**Remaining concerns:** <any issues you couldn't fix, or things that need human review>

## Rules
- NEVER skip a file — review every changed file
- NEVER rubber-stamp your own work — assume there ARE bugs and find them
- NEVER retry a failed approach more than twice
- After completing the review, STOP — do not self-initiate follow-up work`;
}

/**
 * Run a separate Claude invocation with read-only tools to verify work.
 * Returns { passed: boolean, details: string }.
 *
 * @param {Function} askClaudeFn — the askClaude function from bot.js (avoids circular deps)
 * @param {string} cwd — working directory for the project
 * @param {string} taskDescription — what was built
 * @returns {Promise<{passed: boolean, details: string}>}
 */
async function runQAGate(askClaudeFn, cwd, taskDescription) {
  if (typeof askClaudeFn !== 'function') {
    return { passed: false, details: 'QA gate error: askClaudeFn is not a function' };
  }
  if (!cwd || typeof cwd !== 'string') {
    return { passed: false, details: 'QA gate error: cwd is required' };
  }
  if (!taskDescription || typeof taskDescription !== 'string') {
    taskDescription = 'the most recent changes';
  }

  const qaPrompt = `QA GATE: Verify the following task was completed correctly: "${taskDescription}"
1. Read recently changed files (git diff --name-only HEAD~1)
2. Check that imports resolve
3. Check that tests pass
4. Check for obvious regressions
5. Respond with exactly "QA:PASS" or "QA:FAIL: <reason>"`;

  try {
    const result = await askClaudeFn(qaPrompt, {
      cwd,
      readOnly: true,
      maxTurns: 10,
      model: 'sonnet',
      streamReplies: false,
    });
    const text = result?.text || '';
    // Check for QA:FAIL first — if both markers appear, treat as failure
    const failed = text.includes('QA:FAIL');
    const passed = !failed && text.includes('QA:PASS');
    return { passed, details: text };
  } catch (err) {
    return { passed: false, details: `QA gate error: ${err.message}` };
  }
}

module.exports = { buildSelfReviewPrompt, runQAGate };
