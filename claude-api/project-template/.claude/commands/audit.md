# Audit — Full Project Audit with Approval Gates

Comprehensive multi-agent audit that reviews design, product, QA, security, analytics, and performance — then fixes approved issues.

**Usage:** `/audit` for full audit, or specify focus in your prompt (e.g. "audit security only").

## Audit Rules

1. **PROPOSE BEFORE ACTING** — Present findings and plan, STOP, wait for approval before coding.
2. **COST GATING** — List anything that costs money, wait for consent.
3. **ASK QUESTIONS** — Ask clarifying questions when intent is unclear.
4. **ITERATE UNTIL DONE** — Re-audit after fixes. Don't declare done early.
5. **SCREENSHOTS MANDATORY** — Playwright screenshots for every finding.

---

## Phase 1: Discovery

1. Read CLAUDE.md, NextSteps.md, package.json, key project files
2. Determine tech stack, build commands, how to run
3. Build and launch the project
4. Use Playwright to screenshot every screen/page:
   - Desktop: 1280×800 viewport
   - Mobile: iPhone 14 (390×844), Pixel 7 (412×915) via viewport emulation
5. Present: project summary, screens found, proposed audit plan, questions, cost estimates

**STOP and wait for user approval.**

---

## Phase 2: Parallel Agent Review

After approval, launch ALL agents in parallel:

### Design Agent (`lead-designer`)
Visual consistency, spacing, typography, colors, dark mode, responsive, accessibility, component states.

### Product Agent (`principal-product-manager`)
Feature completeness vs requirements, user flows, empty/loading/error states, copy review.

### QA Agent (`qa-engineer` + `manual-qa-tester`)
Click every button, test every form, edge cases, error handling, console errors, screenshot bugs.

### Security Agent (`backend-lead-engineer`)
Input validation, auth, XSS/CSRF/injection, secrets, `npm audit`, API security.

### Analytics Agent (`data-scientist`)
Event tracking coverage, naming consistency, funnel instrumentation, privacy compliance.

### Performance Agent (`principal-engineer`)
Bundle size, render perf, network calls, caching, image optimization, lazy loading.

Each agent: screenshots of every issue, document location/expected/actual/severity.

---

## Phase 3: Issue Compilation

Compile all findings into prioritized table:

| # | Category | Severity | Location | Description | Screenshot |
|---|----------|----------|----------|-------------|------------|

Group by category, sort by severity (Critical → Low).

**STOP and wait for user to approve which issues to fix.**

---

## Phase 4: Fix Execution

1. Group related issues into batches
2. Present fix plan, get approval
3. Implement with parallel agents
4. After each batch: rebuild, re-test, verification screenshots

---

## Phase 5: Verification

1. Re-audit all fixed areas
2. Before/after screenshots
3. New issues → back to Phase 3
4. Continue until clean

---

## Phase 6: Final Report

- Summary: found/fixed/deferred
- Screenshot gallery (before/after)
- Remaining recommendations
- Update NextSteps.md
- Commit changes
