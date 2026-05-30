'use strict';

/**
 * orchestrator.js — Prompt builder for multi-agent orchestrated workflows.
 *
 * This does NOT replace Claude Code's Agent tool — it generates structured
 * prompts that tell Claude how to decompose work, dispatch to agents in
 * the right order, and run a self-review gate at the end.
 *
 * Exports:
 *   buildOrchestrationPrompt(templateName, taskDescription, context)
 *   listTemplates()
 */

const TOKEN_BUDGET_RULES = `## Token Budget Rules (MANDATORY)
- **NEVER retry a failed approach more than twice** — if it fails twice, stop and report the blocker.
- **After completing the task, STOP** — do not self-initiate follow-up work, bonus improvements, or "while I'm here" changes.
- **Keep agent spawns to the minimum needed** — don't spawn an agent for something you can do in 2 lines yourself.
- **Prefer parallel agent spawns** when agents are independent — don't serialize work that can run concurrently.`;

const TEMPLATES = {
  'engineering-task': {
    description: 'Full engineering workflow: analysis, implementation, review, and QA gate.',
    phases: [
      {
        name: 'Analysis',
        instructions: `Spawn **principal-engineer** and **principal-product-manager** agents IN PARALLEL to analyze the task. Each agent reports:
- **Scope:** what needs to change, which files/modules are affected
- **Risks:** what could break, what's fragile, what has no test coverage
- **Dependencies:** external services, packages, APIs involved
- **Estimated complexity:** low / medium / high, with justification

Wait for both agents to complete before moving to Phase 2.`,
      },
      {
        name: 'Implementation',
        instructions: `Based on Phase 1 analysis, implement the solution. Use the Agent tool to spawn specialized agents as needed:
- **frontend-lead** — for UI/UX changes, component work, styling
- **backend-lead** — for API routes, database changes, business logic
- **ai-engineer** — for prompt engineering, model integration, AI pipelines

Each agent should:
1. Read the relevant files before making changes
2. Write clean, production-quality code
3. Add or update tests for new functionality
4. Commit changes with clear commit messages`,
      },
      {
        name: 'Review',
        instructions: `Spawn **principal-engineer** as a code reviewer. The reviewer must:
1. Run \`git diff HEAD~1\` (or however many commits this task produced)
2. Read every changed file line-by-line
3. Check for: broken imports, missing error handling, security issues, edge cases, hardcoded values
4. Run the test suite: \`npm test\` or \`node --test tests/*.test.js\`
5. Report all issues found with file, line, and description
6. Fix any issues — do not just report them`,
      },
      {
        name: 'QA Gate',
        instructions: `Final verification gate:
1. Run \`npm test\` or \`node --test tests/*.test.js\`
2. If tests fail, fix them and re-run — up to 2 retries max
3. Run \`git diff --stat\` to confirm all changes are committed
4. Report final test results and a summary of what was built

If tests pass, respond with: **QA: PASS**
If tests fail after retries, respond with: **QA: FAIL** and the failure details.`,
      },
    ],
  },

  'self-improvement': {
    description: 'Autonomous self-improvement: audit the project, prioritize fixes, execute top items.',
    phases: [
      {
        name: 'Audit',
        instructions: `Read **NextSteps.md** and **CLAUDE.md** to understand the project's current state and priorities.

Spawn domain agents IN PARALLEL to audit their respective areas:
- **principal-engineer** — code quality, architecture, tech debt, dead code, performance
- **security-engineer** — secrets in code/logs, input validation, auth/authz, dependency vulnerabilities (\`npm audit\`)
- **qa-engineer** — test coverage gaps, untested edge cases, flaky tests, missing integration tests
- **product-manager** — feature completeness vs CLAUDE.md requirements, UX gaps, user-facing bugs

Each agent must produce a ranked list of findings with severity: Critical > High > Medium > Low.`,
      },
      {
        name: 'Prioritize',
        instructions: `Synthesize ALL agent findings from Phase 1 into a single prioritized list.

Ranking order (highest to lowest priority):
1. **Security** — vulnerabilities, exposed secrets, injection risks
2. **Bugs** — broken functionality, crashes, data corruption
3. **Performance** — bottlenecks, memory leaks, unnecessary work
4. **Quality** — code cleanliness, test coverage, documentation

Pick the **top 3 actionable items** that deliver the most impact. Present the plan and reasoning, then proceed to Phase 3.`,
      },
      {
        name: 'Execute',
        instructions: `Implement fixes for the top 3 items selected in Phase 2. For each item:
1. Describe what you're fixing and why
2. Make the code changes
3. Add or update tests
4. Commit with a clear message explaining the fix

Use agents as needed — but only if the fix is complex enough to warrant one. Simple fixes (one-liners, config changes) should be done directly.`,
      },
      {
        name: 'Self-Review',
        instructions: `Review ALL changes made in Phase 3:
1. Run \`git diff\` to see everything that changed
2. Read each changed file — check for regressions, broken imports, missing error handling
3. Run \`npm test\` or \`node --test tests/*.test.js\`
4. If tests fail, fix and re-run (max 2 retries)
5. Verify nothing outside the intended scope was broken

Report: what was fixed, test results, and any remaining concerns.`,
      },
    ],
  },
};

/**
 * Build a structured orchestration prompt from a template.
 *
 * @param {string} templateName — key into TEMPLATES
 * @param {string} taskDescription — what the user wants done
 * @param {object} context — optional context: { cwd, projectName, personality }
 * @returns {string|null} prompt string, or null if template not found
 */
function buildOrchestrationPrompt(templateName, taskDescription, context = {}) {
  const template = TEMPLATES[templateName];
  if (!template) return null;

  const projectName = context.projectName || 'this project';
  const cwd = context.cwd || '.';

  const phaseBlocks = template.phases.map((phase, i) => {
    return `## Phase ${i + 1}: ${phase.name}

${phase.instructions}

${i < template.phases.length - 1 ? `**Complete Phase ${i + 1} before moving to Phase ${i + 2}.**` : '**This is the final phase. Report results and STOP.**'}`;
  }).join('\n\n---\n\n');

  const taskBlock = taskDescription
    ? `## Task\n\n${taskDescription}`
    : '## Task\n\nNo specific task provided. Use your best judgment based on the project state.';

  return `# ORCHESTRATION MODE — ${template.description}

**Project:** ${projectName}
**Working directory:** \`${cwd}\`
**Template:** ${templateName}

${TOKEN_BUDGET_RULES}

---

${taskBlock}

---

${phaseBlocks}`;
}

/**
 * List available orchestration templates.
 *
 * @returns {Array<{name: string, description: string}>}
 */
function listTemplates() {
  return Object.entries(TEMPLATES).map(([name, t]) => ({
    name,
    description: t.description,
  }));
}

module.exports = { buildOrchestrationPrompt, listTemplates };
