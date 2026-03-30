# MyBot — Session Handoff (2026-03-29)

## Current Status
- Bot is running via `docker compose up -d --build` from the MyBot directory
- Docker Engine in WSL (v29.3.1), `restart: unless-stopped` for crash recovery
- All features deployed and healthy

## What's Working
- Discord bot (**BiancaDaCow**) is live and responding
- Claude Code CLI integration (subscription-based, stream-json)
- Per-channel session persistence, identity/personality switching
- Morning briefing (9am PT), weekly preview (Sunday noon), evening check-in (10pm PT)
- Briefing modules: stocks, weather, news, jobs, tasks, mindfulness
- Image generation, web browsing (Playwright), sub-agent tracking
- `!restart`, `!email`, `!processes`, `!btw`, `!startproject` wizard, `!cancel`
- `!schedule` / `!schedules` / `!unschedule` / `!autoschedule`
- `!monitor ci` / `!monitor health` / `!monitors`
- `!queue` / `!queued` / `!dequeue`
- `!audit`, `!bugs`, `!preview`, `!skills`
- Error alerting to `#bot-errors` with dedup
- Auto-resume after crash, crash-loop recovery (3x in 2min → rollback)
- Safe-rebuild with last-known-good snapshot

### New: Security Hardening
- **Access control** — `ALLOWED_USER_IDS` and `ADMIN_USER_IDS` env vars (empty = allow all for backward compat)
- **Admin-only commands** — `!restart`, `!killall`, `!identity`, `!name`, `!personality`, `!autoschedule` gated
- **Shell injection fixed** — `execSync` replaced with `execFileSync` + argument arrays in pollers.js and startproject.js
- **Input validation** — repo names, branch names, URLs, identity text all validated
- **Path restriction** — `!cd`, `!ls`, `!startproject` restricted to `/workspace/`
- **System prompt hardening** — security rules block credential reading, env dumping, data exfiltration
- **Environment sanitization** — Claude CLI subprocess only gets PATH, HOME, CI, CHROME_PATH (no API keys)
- **Image path restriction** — attachments only from `/workspace` or `/tmp`
- **SSRF mitigation** — monitor health URLs validated (http/https only)
- **`.dockerignore` created** — excludes .env, .git, .claude, node_modules
- **stderr no longer leaked** in `/ask` endpoint responses

### New: Social Planning & Coordination
- **`!plan <link or description>`** — paste a TikTok/Instagram/Maps/Yelp/Eventbrite link or describe a place; bot researches it (pet-friendly, distance, weather, budget, calendar)
- **`!trip`** — full trip planning wizard: destination → research → companions → dates → itinerary → share/calendar
- **`!hangout`** — group hangout wizard: what → who (@mentions) → check calendars → find overlapping free time → create events
- **`!connect`** — DMs Google OAuth link for calendar access (multi-user)
- **`!spotify`** — DMs Spotify OAuth link for playlist integration
- **Auto link detection** — paste a social media link in any message, bot auto-triggers the social plan wizard
- **Channel participant detection** — bot scans recent messages to identify who's active (GuildMembers intent)
- **Discord interactive components** — buttons for quick actions (Add to Calendar, Share, Get Directions, More Info), voting, time slot selection
- **Collaborative Spotify playlists** — analyzes both users' music tastes, creates road trip playlist with 40% shared / 30% each user mix, destination-themed tracks, "stay awake" high-energy mode
- **Preference interview** — wizard asks: pet-friendly, budget/splurge, hotel, restaurants, playlist, calendars, driving/flying
- **Multi-user Google Calendar** — OAuth per user, free/busy queries, overlapping time finder, group event creation

## Architecture
```
Discord message → Discord.js bot (claude-api container) → Claude CLI (stream-json) → reply to Discord
```
- `claude-api/` container: Express server (port 3400) + Discord.js bot
- Claude CLI authenticates via mounted credentials from host
- Docker socket mounted for self-rebuild capability
- OAuth callbacks: `/auth/google/callback`, `/auth/spotify/callback`

## Key Files
| File | Purpose |
|------|---------|
| `claude-api/bot.js` | Main bot — commands, Claude CLI wrapper, system prompt, progress tracking |
| `claude-api/server.js` | Express server — `/ask`, `/imagine`, `/health`, OAuth callbacks |
| `claude-api/link-extractor.js` | Detects TikTok/Instagram/Maps/Yelp/Eventbrite URLs |
| `claude-api/discord-components.js` | Discord buttons, embeds, voting, interaction routing |
| `claude-api/planning-context.js` | Aggregates venue info for trip planning |
| `claude-api/google-auth.js` | Google OAuth flow for multi-user calendar |
| `claude-api/calendar-coordinator.js` | Multi-user free/busy, overlapping time, group events |
| `claude-api/user-tokens.js` | Google OAuth token storage |
| `claude-api/spotify-auth.js` | Spotify OAuth flow + API client |
| `claude-api/spotify-tokens.js` | Spotify OAuth token storage |
| `claude-api/spotify-planner.js` | Collaborative playlist generation |
| `claude-api/wizards/social-plan.js` | Social plan wizard (drop a link → full plan) |
| `claude-api/wizards/hangout.js` | Group hangout wizard with calendar coordination |
| `claude-api/wizards/trip-planner.js` | Full trip planning wizard |
| `claude-api/pollers.js` | GitHub CI and URL health check pollers |
| `claude-api/monitor-config.js` | Monitor config CRUD |
| `claude-api/monitor-runner.js` | Timer-based polling loop |
| `claude-api/briefings.js` | Briefing system — data fetchers, scheduler |
| `claude-api/error-alerting.js` | Error alerting to #bot-errors |
| `claude-api/wizard.js` | Generic multi-step wizard engine |
| `claude-api/personalities/` | Personality files |
| `docker-compose.yml` | Container config, env vars, volume mounts |

## Environment Variables Needed
```
DISCORD_BOT_TOKEN=...
OPENAI_API_KEY=...            # for image generation
ALLOWED_USER_IDS=             # comma-separated Discord user IDs (empty = allow all)
ADMIN_USER_IDS=               # comma-separated admin user IDs (empty = all are admin)
GOOGLE_CLIENT_ID=             # for multi-user calendar (optional)
GOOGLE_CLIENT_SECRET=         # for multi-user calendar (optional)
GOOGLE_REDIRECT_URI=          # default: http://localhost:3400/auth/google/callback
SPOTIFY_CLIENT_ID=            # for playlist generation (optional)
SPOTIFY_CLIENT_SECRET=        # for playlist generation (optional)
SPOTIFY_REDIRECT_URI=         # default: http://localhost:3400/auth/spotify/callback
```

## Likely Next Steps
1. **Set up Google OAuth** — create Google Cloud credentials, add to .env, test `!connect` and `!hangout`
2. **Set up Spotify OAuth** — create Spotify app credentials, add to .env, test `!spotify` and playlist generation
3. **Set access control** — add your Discord user ID to `ALLOWED_USER_IDS` and `ADMIN_USER_IDS` in .env
4. **More personalities** — add new personality files in `claude-api/personalities/`
5. **Refine social plan wizard** — tune the preference interview, improve plan output formatting
