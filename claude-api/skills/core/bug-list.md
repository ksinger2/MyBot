---
name: bug-list
description: Queue and orchestrate multi-agent bug fixing with product, design, engineering, and QA agents
triggers:
  - /bug-list
  - /bugs
  - queue up bugs
requires:
  - spawn_agent
  - read_file
  - write_file
  - edit_file
  - run_command
  - screenshot
  - browser_automation
---

# Bug List Orchestration Skill

## Overview
I am going to just go on listing and queueing up every bug or issue I find and I want you to kick off the agents to address all of them as they come in. NOTE it is VITAL that NO two agents should EVER be editing or working on the same file at the same time to ensure there are no merge conflicts.

## Orchestration Rules

It is your job to orchestrate all of the agents and coordinate them to make sure they follow this structure as they address all issues:

### Pre-Implementation Requirements
Agents must plan out their approach, review and criticize and try to find holes or issues with their approach and then refine their approach before ever getting started on a fix.

### Routing Rules
- Only very engineering centric bugs like crashes or code issues should go straight to engineering agents
- All other issues/bugs should be routed to the product manager agent first

## Agent Workflow

### Step 1: Product Manager Agent
- Creates VERY clear tasks and requirements based on issue from user
- Hands off to Project Manager Agent AND Designer Agent (in parallel)

### Step 2a: Project Manager Agent (parallel with Designer)
- Tracks all tasks and progress
- Creates all test case scenarios and features to test
- Ensures QA agent knows exactly what to expect
- Ensures every single flow is tested

### Step 2b: Designer Agent (parallel with Project Manager)
- Creates all design requirements with very clear specs:
  - Curvature
  - Color
  - Transparency
  - Materials
  - Different states (active, hover, clicked, etc.)
  - Fonts
  - Sizes
  - Z value
  - Anything that helps ensure engineers build EXACTLY what is expected
  - Behavior across all cases, edge cases, and errors

### Step 3: Engineering Agents
Once design is ready or as each part becomes locked and ready, engineering agents kick off:

1. **Review Phase**
   - Review issue and designs for fix

2. **Planning Phase**
   - Plan out their approach

3. **Refinement Phase**
   - Poke for any holes or more optimized ways to achieve the fix
   - Keep poking iteratively until the agent feels HIGH CONFIDENCE in their solution being:
     - The best
     - The cheapest
     - The most optimized

4. **Implementation Phase**
   - Implement the fix
   - CRITICAL: Check file lock registry before editing any file
   - Register files being edited to prevent conflicts

5. **Code Review Phase**
   - Hand off to another engineering agent for code review
   - Iterate on feedback until ready

6. **Handoff Phase**
   - Submit the fix to QA for testing
   - Move on and pick up a new issue off the list

### Step 4: QA Agent
Once QA gets handed a feature from engineering:

1. **Test Execution**
   - Kick off the experience
   - Test using the right tools to:
     - Click
     - Hover
     - Long press
     - Interact in any form with the experience
   - Test across all screens

2. **Validation**
   - Ensure everything is working EXACTLY as expected
   - Review design specs
   - Show screenshots to design agent for approval
   - Delete screenshots after reviewed to save space

3. **Bug Reporting**
   - If any new issues arise or bugs with implementation
   - Hand the issue back off to engineering team
   - Add to their list of issues

4. **Iteration Loop**
   - Once engineering gets the issue, they fix it
   - Resume same circular automation until there are no more issues to fix

## File Conflict Prevention

### CRITICAL RULES
1. Maintain a file lock registry tracking which files are being edited by which agent
2. Before any agent edits a file, check if it's locked
3. If locked, either:
   - Wait for the lock to be released
   - Pick up a different task that doesn't conflict
4. Release locks immediately after completing edits to a file
5. Never allow two agents to claim the same file simultaneously

## Bug Queue Management

- Maintain a prioritized queue of incoming bugs
- Track status of each bug through the pipeline
- Route new bugs to appropriate starting agent based on type
- Allow continuous addition of new bugs while processing existing ones
