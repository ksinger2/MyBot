const path = require('path');

function buildReinitPrompt(cwd) {
  const projectName = path.basename(cwd);
  return `# PROJECT RE-INIT MODE — ${projectName}

You are starting a fresh session in \`${cwd}\`.

## Goal

Re-initialize yourself on the current state of the project, then propose the most important next steps.

## Requirements

1. Read \`NextSteps.md\` first.
2. Read other core project context files that exist and are relevant, including \`CLAUDE.md\`, \`WORKQUEUE.md\`, \`QA-TESTS.md\`, package manifests, Docker/config files, and test files.
3. Launch domain agents in parallel with the Agent tool. Each agent must read the files relevant to its domain before giving recommendations.
4. If a domain has no dedicated files, say that explicitly and fall back to the closest relevant sources in the repo.
5. Do not make code changes. This command is for analysis and recommendations only.

## Domain Agents

Launch ALL of the following in parallel:

### Project Agent
**Role:** principal-product-manager
**Must read:** \`NextSteps.md\`, \`WORKQUEUE.md\`, \`CLAUDE.md\`, onboarding/setup docs, command surface
**Focus:** Current project state, unfinished work, priorities, user-visible gaps, sequencing

### Design Agent
**Role:** lead-designer
**Must read:** design docs, UI-related markdown, personality/style files, user-facing command/help text, any frontend or presentation-layer files if present
**Focus:** UX clarity, copy, interaction design, consistency, missing design documentation

### Engineering Agent
**Role:** principal-engineer
**Must read:** core runtime code, command routing, runner/prompt logic, server entry points, package manifests, tests
**Focus:** architecture, correctness risks, maintainability, missing implementation work, technical debt

### Security Agent
**Role:** security-engineer
**Must read:** auth/permissions code, secret handling, sandbox/tooling code, server endpoints, security tests
**Focus:** likely vulnerabilities, unsafe defaults, missing validation, privilege boundaries, test gaps

### QA Agent
**Role:** qa-engineer
**Must read:** \`QA-TESTS.md\`, automated tests, workflow docs, command handlers
**Focus:** missing test coverage, unverified flows, brittle behavior, regression risks

## Output Format

Produce a concise re-init report with these sections:

1. **What each agent reviewed**
2. **Current project state**
3. **Findings by domain**
4. **Recommended next steps**
   - Prioritize into Now / Next / Later
   - Keep steps concrete and repo-specific
5. **Open questions / unknowns**

Start by reading \`NextSteps.md\`, then spawn the domain agents.`;
}

module.exports = { buildReinitPrompt };
