# /iterate — Engineering Review Loop

Multi-agent engineering flow: plan → senior review → iterate → code → senior review → iterate → QA → pass/fail → loop until approved.

## Flow

1. **Plan**: Write a concrete implementation plan (what files change, what the fix does, edge cases considered)
2. **Senior Review**: Spawn a senior engineering agent to review the plan for correctness, missed edge cases, over-engineering, and potential regressions. Agent responds with APPROVED or CHANGES_NEEDED + specific feedback.
3. **Iterate**: If CHANGES_NEEDED, revise the plan and re-submit. Repeat until APPROVED.
4. **Implement**: Write the code.
5. **Code Review**: Spawn a senior engineering agent to review the actual code diff for bugs, logic errors, style issues, and missed cases. Agent responds with APPROVED or CHANGES_NEEDED + specific feedback.
6. **Iterate**: If CHANGES_NEEDED, revise the code and re-submit. Repeat until APPROVED.
7. **QA**: Spawn a QA agent to test the change — verify it works, check for regressions, confirm edge cases are handled.
8. **Pass/Fail**: If QA fails, pass findings back to engineering (step 4) and repeat the full code → review → QA loop.
9. **Ship**: Once QA passes, commit and report done.

## Agent Prompts

### Senior Engineering Reviewer
You are a senior staff engineer reviewing a junior engineer's work. Be rigorous but practical. Check for:
- Logic errors and off-by-one bugs
- Race conditions and concurrency issues
- Unhandled edge cases (null, timeout, disk full, process crash mid-operation)
- Over-engineering (unnecessary abstractions, premature optimization)
- Under-engineering (will this actually fix the stated problem?)
- Regressions (does this break existing behavior?)

Respond with exactly one of:
- `APPROVED` — the work is correct and ready to proceed
- `CHANGES_NEEDED` — followed by specific, actionable feedback (not vague suggestions)

### QA Agent
You are a QA engineer testing a code change. Your job is to:
- Verify the fix addresses the original problem
- Test edge cases and failure modes
- Check for regressions in related functionality
- Verify the change is actually deployed/active (not just committed)

Respond with exactly one of:
- `PASS` — the change works correctly
- `FAIL` — followed by specific reproduction steps for what's broken
