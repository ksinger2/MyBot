# Fix — Team QA & Fix Workflow

Comprehensive team-based QA workflow for testing and fixing issues using parallel agent review and coordinated testing.

## Phase 1: Parallel Document Review

Launch all review agents in parallel to analyze their domain-specific documentation:

### Design Team Review
**Agent:** `lead-designer`
**Task:** Review all design-related documentation and specs.
**Focus:** Design system compliance, spacing, colors, typography, component specs, accessibility, dark mode.

### Engineering Team Review
**Agent:** `principal-engineer`, `frontend-lead-engineer`, `backend-lead-engineer`
**Task:** Review engineering documentation, code patterns, and architecture docs.
**Focus:** Code patterns, architecture decisions, API contracts, performance, security.

### Product & Project Management Review
**Agent:** `principal-product-manager`, `project-manager`
**Task:** Review PRDs, implementation plans, and feature specs.
**Focus:** Feature completeness, acceptance criteria, user stories, exit criteria.

---

## Phase 2: Team Leads Assembly

Once Phase 1 reviews complete, assemble the 4 Team Leads:
1. **Product Manager** — Feature requirements & acceptance criteria
2. **Principal Engineer** — Technical standards & code quality
3. **Design Lead** — Visual specs & UX patterns
4. **Project Manager** — Task coordination & delivery tracking

### Ask User for Focus Area
**IMPORTANT:** Before proceeding, ask:
> "The team reviews are complete. Which feature or screen would you like the Team Leads to focus on testing and fixing?"

---

## Phase 3: Build & Test Setup

Once the focus area is specified:
1. Build the project (use build commands from CLAUDE.md)
2. Launch the app/service
3. Verify it's running and accessible
4. Take initial screenshots/state capture

---

## Phase 4: Feature Testing Protocol

Team Leads systematically test the specified feature:

### For Each State/Interaction:
1. **Navigate** to the feature/screen
2. **Screenshot** the current state
3. **Inspect** accessibility tree and UI elements
4. **Test interactions**: taps, scrolls, swipes, text input, add/edit/delete
5. **Document** each resulting screen/state
6. **Discuss** if anything is wrong:
   - Does it match design specs?
   - Is the UX intuitive?
   - Are there overflow/clipping issues?
   - Do all buttons work?
   - Are loading/error/empty states handled?

### Create Issue List
For each problem: Screen/Location, Expected, Actual, Severity, Screenshot.

---

## Phase 5: Fix Workflow

For each issue:

### 5.1 Design Review
Design Lead reviews and updates specs if needed.

### 5.2 Engineering Planning
Engineer(s) create fix plan: files to modify, approach, edge cases.

### 5.3 Principal Engineer Approval
Review against: clarity, simplicity, optimization, standards, no over-engineering.

### 5.4 Implementation
Engineer implements the approved fix.

### 5.5 Code Review
Principal Engineer verifies: bugs, inconsistencies, hardcoded values, crashes, security, privacy, memory leaks.

---

## Phase 6: Verification

1. Rebuild and launch
2. All Team Leads verify: the specific fix, related functionality, all states, design compliance
3. Sign-off checklist:
   - [ ] Product Manager: Meets acceptance criteria
   - [ ] Design Lead: Matches visual specs
   - [ ] Principal Engineer: Code quality approved
   - [ ] Project Manager: Ready for delivery

---

## Phase 7: Documentation & Commit

1. Update relevant documentation with what changed
2. Update `NextSteps.md` with current state
3. Commit changes with descriptive message
4. Report summary: issues found/fixed, files modified, commit hash
