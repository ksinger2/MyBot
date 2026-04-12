# QA — Comprehensive Quality Assurance

Run a full QA pass on the most recent changes. This command kicks off the QA agent lead to coordinate testing.

## Phase 1: Context Gathering

Review the recent conversation context and identify:
- What was added or changed
- Which files were modified
- Which features or screens are affected
- What the expected behavior should be

Run `git diff` and `git log --oneline -5` to understand recent changes.

## Phase 2: Test Matrix Creation

The QA lead creates a comprehensive test matrix covering:
- Every screen affected by the changes
- Every button and interactive element on those screens
- Every state: default, loading, error, empty, offline
- Every user flow that touches the changed code
- Edge cases: long text, special characters, rapid taps, interruptions

## Phase 3: Automated Testing

Launch the **qa-engineer** agent to:
1. Run existing automated tests and report results
2. Write new tests for any untested changes
3. Verify test coverage on modified files

## Phase 4: Manual Testing

Launch the **manual-qa-tester** agent to:
1. Physically click through every screen and interaction
2. Use appropriate tools for the platform:
   - **Web**: Playwright or browser automation
   - **iOS**: MCP iOS simulator tools (`mcp__ios-simulator__screenshot`, `mcp__ios-simulator__ui_tap`, etc.)
   - **Android**: MCP Android simulator tools if available
3. Capture screenshots of every screen state
4. Test on multiple platforms/devices if applicable
5. Verify accessibility (screen readers, contrast, touch targets)

## Phase 5: Issue Documentation

For each issue found, document:
- **Location**: Screen, component, or feature
- **Steps to reproduce**: Exact sequence
- **Expected behavior**: What should happen
- **Actual behavior**: What actually happens
- **Severity**: Critical / High / Medium / Low
- **Screenshot**: Visual evidence

## Phase 6: Report

Provide a structured QA report:

```
## QA Report

### Summary
- Total tests: X
- Passed: X
- Failed: X
- New issues: X

### Issues Found
| # | Location | Description | Severity | Screenshot |
|---|----------|-------------|----------|------------|

### Test Coverage
- Automated test coverage: X%
- Manual test coverage: [screens tested / total screens]

### Recommendation
[Ship / Fix before shipping / Block release]
```

## Phase 7: Fix Coordination

If issues are found:
1. Prioritize by severity (Critical first)
2. Assign fixes to appropriate engineers
3. After fixes, re-test affected areas
4. Only sign off when ALL issues are resolved or documented as known issues
