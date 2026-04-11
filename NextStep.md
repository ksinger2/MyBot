# MyBot — Session Handoff (2026-04-11)

## Current status
- **Discord** (`BiancaDaCow#3914`) — live, healthy
- **Signal** (`+15106412088`) — live, healthy, **`MODE=json-rpc` + webhook** (~5x faster than the previous `MODE=normal` polling setup)
- Both run from a single `mybot-claude-api` container; signal-cli runs in the `mybot-signal-api` sidecar
- Bring up: `docker compose --profile signal up -d --build`
- Tear down: `docker compose --profile signal down`

## Architecture (current)
```
Discord gateway → discord.js client → bot.js messageCreate → Claude CLI → reply
Signal phone   → signal-cli (json-rpc daemon) → bbernhard REST →
                 POST /signal/webhook → SignalAdapter._handleIncoming → bot.js → Claude CLI → reply
```
- One persistent signal-cli daemon (port 6001 inside signal-api). No JVM cold-starts per call.
- Webhook route in `claude-api/server.js` unwraps `{jsonrpc, method:"receive", params}` frames, ignores `{jsonrpc, result, id}` ack frames, and passes the envelope to `SignalAdapter._handleIncoming`.
- Send path uses `recipients: ['group.{base64(internal_id)}']` for groups, raw phone for DMs. Real typing indicator via `PUT /v1/typing-indicator/{number}`.

## What's working
- Discord DMs, mentions, and `!commands` in guild channels
- Signal DMs and groups where Bianca is already a member
- All `!commands` work on both platforms
- Per-channel personality and identity, swap with `!personality <name>`
- Per-user profile system (phone-keyed) — name, location, timezone, gcal email/connected
- **Conversational onboarding wizard** for new Signal users (no web form needed) — see `wizards/onboarding.js`
- Group member context — when in a Signal group, the bot fetches all known members' profiles and injects them into Claude's context for "plan for us" / "what works for everyone" coordination
- Real read-only enforcement for non-owner Signal users via Claude CLI `--disallowedTools` (Edit, Write, NotebookEdit, Bash, etc. are physically disabled — not just prompt-restricted)
- TikTok / Instagram / YouTube **video transcripts** via yt-dlp + OpenAI Whisper, injected into Claude's prompt for accurate "tldr" / "summarize" / "plan for us" answers
- `!loop <task>` — autonomous loop with cost cap (`MAX_LOOP_COST_USD`, default $5), sentinel + idle done detection, per-iteration retry with cool-down
- `!heartbeat <minutes>` — periodic wake with in-flight guard, error backoff, smarter `NO_ACTION_NEEDED` matching
- Auto-resume after restart — Signal channels now get a "I'm back" message instead of being silently dropped
- Pre-rebuild user warning — system prompt rule tells Claude to warn the user before any `docker compose up -d --build`

## Capabilities Claude has (injected into system prompt)
1. **Image generation** — `curl -s -X POST http://localhost:3400/imagine` with a JSON prompt
2. **Web browsing** — Playwright MCP (Chromium) + WebFetch + WebSearch
3. **Code & files** — full read/write/edit/shell (owner only on Signal)
4. **Docker** — `docker ps`, `docker compose up -d --build`, etc. (mounted socket)
5. **Git & GitHub** — full workflow via `gh` CLI
6. **Sub-agents** — `Task` tool for parallel research / multi-step jobs
7. **Multi-project** — `/workspace/` contains all projects, `cd` between them
8. **Video transcripts** — yt-dlp + ffmpeg + OpenAI Whisper for any TikTok/Instagram/YouTube link the user sends

## Discord commands (all work on Signal too)
- **Control:** `!stop`, `!clear`, `!kill`, `!killall`, `!restart`, `!refresh`, `!status`, `!btw`, `!processes`, `!cancel`
- **Workspace:** `!cd`, `!ls`, `!startproject`
- **Identity:** `!name`, `!identity`, `!personality`, `!personalities`
- **Config:** `!config show|turns|continues|timeout <N>`
- **Autonomy:** `!loop <task>`, `!heartbeat <minutes>|off|status`, `!orders`
- **Services:** `!services`, `!service stop|logs <name>`
- **Tasks:** `!tasks`, `!done <#>`, `!done all`
- **Schedule:** `!schedule`, `!schedules`, `!unschedule`, `!autoschedule`
- **Queue:** `!queue`, `!queued`, `!dequeue`
- **Monitors:** `!monitor ci|health|remove|pause|resume|check`
- **Briefing:** `!briefing`, `!weekly`, `!ainews`
- **Signal-specific:**
  - `!profile` — view/edit your profile
  - `!setup` — generate a web onboarding link (fallback for users who prefer a form)
  - `!permit +1234567890` / `!revoke +1234567890` / `!perms` — owner-only project access control
  - `!joingroup <signal-invite-link>` — join a group via invite link (bypasses the broken accept-invite flow — see Known Issues)
- **Other:** `!email`, `!imagine`, `!preview`, `!help`

## Personalities available
- `tiffany_pollard` (default) — reality-TV diva
- `april_ludgate` — Aubrey Plaza deadpan, lowercase, no emojis, allergic to cheer
- `schpeedlebot` — pure utility, no fluff, no emphasis, shortest possible answers
- `default` — vanilla helpful

## Key files
| File | Purpose |
|---|---|
| `claude-api/bot.js` | Main bot — message handlers, commands, Claude CLI wrapper, system prompt, Signal integration, !loop, auto-resume |
| `claude-api/server.js` | Express server — `/ask`, `/imagine`, `/health`, `/signal/webhook`, `/setup/:userId`, `/auth/google/calendar/:userId` |
| `claude-api/adapters/signal.js` | SignalAdapter — bbernhard REST client, group ID wrapping, typing indicator, JSON-RPC join-via-uri helper |
| `claude-api/link-extractor.js` | Detects social/location links, fetches oEmbed metadata, runs `fetchVideoTranscript()` (yt-dlp + Whisper) for TikTok/Instagram/YouTube |
| `claude-api/user-profiles.js` | Phone-keyed profile store (name, location, timezone, gcal) |
| `claude-api/project-permissions.js` | Per-project allowlist for non-owner Signal users |
| `claude-api/wizards/onboarding.js` | Conversational 3-step onboarding wizard (name, location, calendar y/n) |
| `claude-api/wizard.js` | Generic wizard engine — supports functional prompts and silent mode |
| `claude-api/heartbeat.js` | Heartbeat scheduler with in-flight guard + error backoff |
| `claude-api/channel-persistence.js` | Per-channel state (sessionId, activeTask, queue) with TTL on stale activeTask |
| `claude-api/personalities/*.md` | Personality definitions |
| `claude-api/Dockerfile` | Now installs `ffmpeg` (apt) + `yt-dlp` (pip) |
| `docker-compose.yml` | `MODE=json-rpc`, `RECEIVE_WEBHOOK_URL`, `SIGNAL_USE_WEBHOOK=true` |

## Environment variables
```
DISCORD_BOT_TOKEN=...
OPENAI_API_KEY=...

# Access control
ALLOWED_USER_IDS=               # Discord user IDs (comma-separated)
ADMIN_USER_IDS=                 # Discord admin user IDs

# Session limits
DEFAULT_MAX_TURNS=50
MAX_AUTO_CONTINUES=5
MAX_TIMEOUT_MINUTES=90
MAX_LOOP_COST_USD=5             # cost cap per !loop run
LOOP_ITERATION_COOLDOWN_MS=5000

# Signal
ENABLED_PLATFORMS=discord,signal
SIGNAL_PHONE_NUMBER=+15106412088
SIGNAL_API_URL=http://signal-api:8080
SIGNAL_OWNER_NUMBER=+16315214787   # only this number can edit code from Signal
SIGNAL_ALLOWED_NUMBERS=             # empty = allow everyone
SIGNAL_USE_WEBHOOK=true             # required for MODE=json-rpc
SIGNAL_API_CONTAINER=mybot-signal-api-1   # for !joingroup docker exec

# Google / Spotify OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# Used by /setup links and !setup command for absolute URL generation
PUBLIC_URL=http://localhost:3400
```

## Known issues

### Pending-invite Signal groups can't be auto-joined
Three groups (`Beep`, `boop`, `Bianca & Booboo`) show the bot in `pending_invites`. signal-cli's `updateGroup -g` (the v2 invite-accept path) throws `"Cannot find service ID for self to accept invite"` on standalone-registered accounts. This happens in BOTH `MODE=normal` and `MODE=json-rpc` — switching modes doesn't fix it.

**Workaround in place:** `!joingroup <invite-link>` command. The user generates a Signal group invite link (group settings → group link → enable + share), pastes it to Bianca, and the bot joins via signal-cli's `joinGroup --uri` (a different code path that bypasses the bug). Implementation: `claude-api/adapters/signal.js:joinGroupByLink()` shells out via `docker exec` into signal-api and calls a Python one-liner that connects to the local JSON-RPC daemon on port 6001.

**Real fix (deferred):** onboard the bot as a *linked device* of a primary phone Signal install instead of registering it standalone. This is what OpenClaw does. Requires setting up Signal on a phone or emulator using `+15106412088`, which the user doesn't currently have. See deep-research report at `~/.claude/plans/logical-noodling-sun-agent-aaa46579895eda2ac.md` for the full diagnosis.

### bbernhard silently swallows JSON-RPC errors
`POST /v1/groups/.../join` returns `204 No Content` even when the underlying `updateGroup` JSON-RPC call fails. Our adapter now verifies actual membership after the call and logs honestly: `Join call returned 204 for "X" but bot is still pending invite — ...`

## Testing checklist for next session

### Live verification
- [ ] **TikTok transcript pipeline** — send a TikTok URL with "tldr" via Signal, confirm Bianca summarizes the actual spoken content (not just title/author). First call ~15-30s due to download + Whisper; cached afterward.
- [ ] **Conversational onboarding** — message Bianca from a phone number that's NOT in `user-profiles.json` and NOT the owner. Confirm the 3-step wizard runs (name → location → calendar y/n) and the OAuth link only appears on yes.
- [ ] **Group member context / "plan for us"** — get a small group of onboarded users with connected calendars, ask "when can we 3 grab dinner this week", confirm Bianca cross-references calendars.
- [ ] **Read-only enforcement** — from a non-owner Signal account, ask Bianca to edit a file in `/workspace/`. Confirm the Edit tool is unavailable (not just refused via prompt rule).
- [ ] **`!joingroup`** — get a real Signal group invite link, send it to Bianca via `!joingroup <link>`, confirm she joins as a real member (verify with `signal-cli listGroups -d` showing `Active: true`).
- [ ] **Pre-rebuild warning** — ask Bianca (from Discord) to make a small code edit and rebuild. Confirm she sends the "rebuilding myself, brb 30s" warning before running `docker compose up -d --build`.
- [ ] **Signal auto-resume** — start a long task on Signal, `docker compose restart claude-api` mid-task, wait for restart. Confirm Bianca sends "I'm back from a restart, I was working on X — resend if you still need it."

### Edge cases worth probing
- [ ] What happens if a user starts the onboarding wizard, then sends `!status`? (`!cancel` is wired, but does a normal `!command` mid-wizard escape cleanly?)
- [ ] What happens if a non-owner user invokes `!loop` from Signal? Should be allowed (not a write operation per se), but `!loop "edit X"` might fail because `--disallowedTools` blocks Edit. Verify the loop bails gracefully.
- [ ] Long Whisper transcripts (>3500 chars) — prompt injection truncates to 3500. Confirm tldr quality on a long video.

## Future work (deferred)

### OpenClaw architectural recommendations
A deep research agent read OpenClaw's source end-to-end during the prior session. The full report is at `/home/karen/.claude/plans/logical-noodling-sun-agent-aaa46579895eda2ac.md`. Top 5 ports the user should consider:

1. **Port `tool-loop-detection.ts`** — three orthogonal loop detectors (generic_repeat, known_poll_no_progress, ping_pong) + a global circuit breaker. Wired as a `before_tool_call` hook that *blocks* a tool call by returning `{blocked: true}`. ~700 LOC. Source: `/tmp/openclaw/src/agents/tool-loop-detection.ts`. Target: new `claude-api/loop-detection.js` + tool-use handler in `bot.js:~780`.
2. **Heartbeat-wake coalesce/priority scheduler** with `requests-in-flight` skip — heartbeats never interrupt active conversations. Source: `/tmp/openclaw/src/infra/heartbeat-wake.ts`. Target: `claude-api/heartbeat.js`.
3. **Replace `!loop` done-detection with a wrapper-tolerant `LOOP_COMPLETE` token strip** — copies the `HEARTBEAT_OK` pattern from `auto-reply/heartbeat.ts:124-185`. The current `<<TASK_COMPLETE>>` sentinel is a simpler version of this.
4. **Supervisor module with `scopeKey` + `replaceExistingScope` + dual timers** — extract from `bot.js:askClaude()` into `claude-api/supervisor.js`. Eliminates the `state.process` / `_userStopped` / `busy` dance and makes `!stop` a one-liner. Source: `/tmp/openclaw/src/process/supervisor/supervisor.ts`.
5. **Channel adapter contract tests** — one suite, run against both Discord and Signal adapters, prevents drift. Source pattern: `/tmp/openclaw/src/channels/plugins/contracts/inbound.{discord,signal}.contract.test.ts`. Target: new `tests/adapters/contract.test.js`.

### iMessage adapter
BlueBubbles on Mac. Same `MessagePlatform` base class pattern as `adapters/signal.js` and `adapters/discord.js`.

### "Tap to onboard" hint in groups
Currently the conversational onboarding wizard only runs in 1:1 DMs (multi-step in a group is confusing). When an unknown user posts in a group, the bot should send them a hint to DM directly for setup.

### SQLite task ledger
`task-ledger.js` does `fs.writeFileSync` of the whole JSON on every mutation — a crash mid-write nukes the file. Move to `node:sqlite` (built-in on Node 22+) with per-task upsert. Cited in OpenClaw research as a high-value, low-effort improvement.

### Linked-device Signal onboarding
The proper fix for pending-invite groups. Requires a phone or Android emulator with Signal installed using `+15106412088`. Once linked, all the `acceptInvite` paths will work because the local account store will have the self ACI/PNI populated via sync messages from the primary.
