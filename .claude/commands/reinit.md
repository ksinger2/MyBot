# Re-initialize Project Context

Read the following files and information to re-establish context for this session.

## 1. Handoff Document
Read `NextSteps.md` in the project root. This contains:
- What was built and the current architecture
- What's working and what's broken
- Specific next steps to pick up from

## 2. Project Configuration
Read `CLAUDE.md` in the project root for:
- Tech stack and architecture overview
- Key conventions and patterns
- How to build, run, and test

## 3. Key Source Files
Identify and read the most critical source files for the project. Look at:
- Entry points (main files, index files, app files)
- Configuration files (package.json, docker-compose.yml, etc.)
- Core business logic files

## 4. Project State
Run these commands to understand current state:
- `git log --oneline -10` to see recent commits
- `git status` to see uncommitted changes
- `PM2_HOME=/home/node/.claude/.pm2 pm2 list` to check running services
- Check if dev server is running: `curl -sf http://localhost:3000/ > /dev/null && echo "Dev server running on 3000" || echo "No dev server on 3000"`

## 5. Settings & Config
- Read `.claude/settings.json` if it exists for project-specific config
- Read `.claude/settings.local.json` if it exists

## 6. Kick Off Domain Reviews
Launch agents in parallel to review their domains:
- **Engineering agents**: Read code files, check for technical debt, review architecture
- **Design agents**: Read any design docs, check UI consistency
- **Product agents**: Read any PRDs or specs, check feature completeness

## 7. Summarize
After reading everything, provide:
1. A brief summary of the project state
2. What's currently working vs broken
3. Running services (PM2 processes, dev servers)
4. The recommended next action to take
5. Any blockers or questions to resolve first
