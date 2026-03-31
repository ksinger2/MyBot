# MyBot — Session Handoff (2026-03-30)

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
- Image generation, web browsing (WebSearch/WebFetch), sub-agent tracking
- `!restart`, `!refresh`, `!email`, `!processes`, `!btw`, `!startproject` wizard, `!cancel`
- `!schedule` / `!schedules` / `!unschedule` / `!autoschedule`
- `!monitor ci` / `!monitor health` / `!monitors`
- `!queue` / `!queued` / `!dequeue`
- `!audit`, `!bugs`, `!preview`, `!skills`
- Error alerting to `#bot-errors` with dedup
- Auto-resume after crash, crash-loop recovery (3x in 2min → rollback)
- Safe-rebuild with last-known-good snapshot

### New: Smart Link Handler
- **Pre-fetches metadata** (~400ms) before sending to Claude — TikTok oEmbed, YouTube oEmbed, OG tags for other platforms
- **Content type classification** — auto-detects event, restaurant, travel, recipe, product, activity from metadata keywords
- **Action playbook prompt** — Claude gets specific instructions per content type (find tickets, check hours, suggest calendar, etc.) instead of generic "summarize"
- **Platform hints** — Yelp→restaurant, Eventbrite→event, Google Maps→restaurant even when metadata can't be fetched
- **New platforms** — YouTube, Twitter/X, Reddit links now detected
- **TikTok short URLs fixed** — oEmbed API works directly with `/t/` URLs, no JS redirect needed
- **Instagram links fixed** — extracts post shortcode/author, tries OG tags first, then forces WebSearch with targeted query. Never tells user "I can't access this"
- **Never-give-up prompt rules** — bot is forbidden from saying it can't access a platform, asking the user what the link is, or apologizing. Must always WebSearch when metadata is missing

### New: CLI Error Recovery & !refresh
- **Exit code recovery** — If CLI exits non-zero but produced a valid response, bot uses it instead of erroring
- **JS falsy bugs fixed** — `total_cost_usd` of 0 and `num_turns` of 0 no longer treated as missing
- **Auto-retry with delay** — CLI failures get one retry after 3s before giving up
- **`!refresh` command** — Nuclear reset from Discord: kills processes, clears all state, purges CLI session cache, restarts container
- **Better error messages** — Error replies now suggest `!refresh` as a fix option

### Security Hardening
- **Access control** — `ALLOWED_USER_IDS` and `ADMIN_USER_IDS` env vars (empty = allow all for backward compat)
- **Admin-only commands** — `!restart`, `!killall`, `!identity`, `!name`, `!personality`, `!autoschedule` gated
- **Shell injection fixed** — `execSync` replaced with `execFileSync` + argument arrays
- **Input validation** — repo names, branch names, URLs, identity text all validated
- **Path restriction** — `!cd`, `!ls`, `!startproject` restricted to `/workspace/`
- **System prompt hardening** — security rules block credential reading, env dumping, data exfiltration
- **Environment sanitization** — Claude CLI subprocess only gets PATH, HOME, CI, CHROME_PATH

### Social Planning & Coordination
- **`!plan <link or description>`** — paste a link or describe a place; bot researches it with context-aware actions
- **`!trip`** — full trip planning wizard
- **`!hangout`** — group hangout wizard with calendar coordination
- **`!connect`** — Google OAuth for calendar access
- **`!spotify`** — Spotify OAuth for playlist integration
- **Auto link detection** — paste a social media link in any message, bot auto-triggers smart link handler
- **Discord interactive components** — buttons for quick actions
- **Multi-user Google Calendar** — OAuth per user, free/busy queries, overlapping time finder

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
| `claude-api/link-extractor.js` | Link detection, oEmbed/OG pre-fetch, content classification, action prompts |
| `claude-api/discord-components.js` | Discord buttons, embeds, voting, interaction routing |
| `claude-api/planning-context.js` | Aggregates venue info for trip planning |
| `claude-api/google-auth.js` | Google OAuth flow for multi-user calendar |
| `claude-api/calendar-coordinator.js` | Multi-user free/busy, overlapping time, group events |
| `claude-api/spotify-auth.js` | Spotify OAuth flow + API client |
| `claude-api/spotify-planner.js` | Collaborative playlist generation |
| `claude-api/wizards/social-plan.js` | Social plan wizard (drop a link → full plan) |
| `claude-api/wizards/hangout.js` | Group hangout wizard with calendar coordination |
| `claude-api/wizards/trip-planner.js` | Full trip planning wizard |
| `claude-api/pollers.js` | GitHub CI and URL health check pollers |
| `claude-api/monitor-config.js` | Monitor config CRUD |
| `claude-api/monitor-runner.js` | Timer-based polling loop |
| `claude-api/briefings.js` | Briefing system — data fetchers, scheduler |
| `claude-api/error-alerting.js` | Error alerting to #bot-errors |
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
1. **Test smart link handler** — paste various TikTok/YouTube/Yelp links and verify context-aware responses
2. **Set up Google OAuth** — create Google Cloud credentials, add to .env, test `!connect` and `!hangout`
3. **Set up Spotify OAuth** — create Spotify app credentials, add to .env, test `!spotify`
4. **Set access control** — add Discord user ID to `ALLOWED_USER_IDS` and `ADMIN_USER_IDS` in .env
5. **More personalities** — add new personality files in `claude-api/personalities/`
