# {{PROJECT_NAME}}

## Project Overview
[Describe what this project does, who it's for, and the core problem it solves]

## Tech Stack
[List frameworks, languages, key dependencies — e.g. "React + TypeScript frontend, FastAPI backend, PostgreSQL"]

## Architecture
[High-level architecture description — how components connect, data flow, key services]

## Key Conventions
[Project-specific patterns, naming conventions, file organization rules]
- Follow existing patterns in the codebase before introducing new ones
- Check for reusable components/utilities before building new ones

## How to Run
[Build and run commands — e.g. `npm install && npm run dev`, `docker compose up`]

## How to Test
[Test commands — e.g. `npm test`, `pytest`, `flutter test`]

## Session Protocol
1. Read `NextSteps.md` before starting work — it has the latest context
2. Update `NextSteps.md` when ending a session — capture what you did, what's broken, and what's next
3. Use `/reinit` to re-initialize project context at the start of each session
4. Use `/qa` after implementing features to run comprehensive QA
5. Use `/fix` to coordinate a team-based fix workflow for issues found
6. Use `/audit` for a comprehensive project audit with approval gates

## Available Agents
This project includes a full product development team in `.claude/agents/`:
- **principal-product-manager** — Product strategy, requirements, competitive analysis
- **principal-engineer** — Architecture decisions, technical standards, cross-team alignment
- **project-manager** — Task tracking, coordination, exit criteria enforcement
- **lead-designer** — Design system, component specs, accessibility, visual QA
- **frontend-lead-engineer** — Frontend architecture, code reviews, component library
- **frontend-engineer** — UI implementation, design system adherence, state handling
- **senior-frontend-engineer** — End-to-end feature building, AI integration
- **backend-lead-engineer** — API design, database, security, infrastructure
- **ai-engineer** — AI/ML integration, prompt engineering, RAG, agent frameworks
- **qa-engineer** — Automated testing, test infrastructure, coverage
- **manual-qa-tester** — Manual testing, interaction testing, visual auditing
- **data-scientist** — Analytics tracking, event taxonomy, measurement plans
