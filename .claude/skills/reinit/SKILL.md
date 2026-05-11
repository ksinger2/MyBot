---
name: reinit
description: Re-initialize the project team at the start of a new session by rebuilding shared context from NextSteps.md, current code, git state, runtime state, and role-specific project documents. Use when a fresh team of agents needs a structured handoff before continuing work.
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(docker*), Bash(git*)
---

# Re-initialize Team Context

Rebuild context for the full team before any agent starts execution. Treat this as a required handoff workflow, not an optional summary pass.

## 1. Read Session Handoff First

Every agent must read `NextSteps.md` in the project root before doing anything else.

Use it to extract:
- what changed in the last session
- what is currently working
- what is broken, risky, or still in progress
- the next recommended tasks
- any operational notes that affect current work

If additional `NextSteps.md` files exist in subprojects, read the root file first and then only read subproject notes that are relevant to the agent's assigned area.

## 2. Review Current Project State

Read the current implementation and environment status needed to understand the handoff:
- `git status`
- `git log --oneline -10`
- `docker compose ps`
- `docker compose logs claude-api --tail 20`

Read the core project files that establish architecture and behavior:
- `docker-compose.yml`
- `claude-api/server.js`
- `claude-api/bot.js`
- `claude-api/Dockerfile`

Read additional files only as needed to understand the specific domain an agent owns.

## 3. Require Domain-Specific Review By Role

After reading `NextSteps.md`, each agent must review the project documents and source material relevant to its own role.

Examples:
- engineers review implementation files, tests, configs, and integration points relevant to the active work
- security agents review auth flows, secrets handling, exposed services, dependency or runtime risks, and any security notes or known vulnerabilities
- QA or testing agents review test plans, failure reports, smoke-test instructions, and recent behavior changes
- operations agents review Docker state, logs, runtime health endpoints, watchdog behavior, and deployment-related configuration
- product or planning agents review backlog, work queue, and handoff notes that define priorities and constraints

Do not stop at the root handoff note if role-specific documents exist and are relevant.

## 4. Check For Persisted Memory

Read saved memory or project notes if present and relevant to the current session so prior decisions are not rediscovered unnecessarily.

## 5. Produce Team Reinit Output

Return a concise team-ready summary with:
1. current project state
2. what is working
3. what is broken or risky
4. role-specific findings each agent should carry forward
5. the best next action for the team to take now

## 6. Team Prompt Template

Use or adapt this prompt when re-initializing the team:

```text
Re-initialize project context before starting work.

Mandatory for every agent:
1. Read the root NextSteps.md first.
2. Extract what changed last session, what works, what is broken, and what should happen next.
3. Review the current git state, Docker/runtime state, and core architecture files.
4. Review all domain-specific documents and files relevant to your role.
   - Engineers: code, tests, configs, integration paths.
   - Security: auth, secrets, exposed surfaces, vulnerabilities, risky defaults.
   - QA: test instructions, smoke paths, regressions, behavior changes.
   - Ops: containers, logs, health endpoints, watchdogs, deployment/runtime concerns.
5. Report only the findings that matter for your role, then align on the single best next action.
```
