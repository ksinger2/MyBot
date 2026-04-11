# MyBot — Session Handoff (2026-04-11, late evening)

## This session's fixes (after the resilience overhaul)
- **Signal self-UUID resolved** — `SignalAdapter._loadSelfInfo()` queries
  `/v1/identities/{phoneNumber}` and caches `this._selfUuid`. Group
  @-mention matching now works for clients that reference the bot by UUID.
- **Per-sub-agent loop detection** — each `activeAgents` entry gets its
  own `loopState`. Tool-use and tool-result handlers route via
  `parent_tool_use_id` → `agentObj.loopState`. Sub-agents no longer
  pollute each other's sliding windows.
- **`/rebuild` project-name bug** — the host-side rebuilder ran
  `docker compose up` inside `/work`, so compose derived project name
  `work` and created duplicate `work-claude-api-1` / `work-signal-api-1`
  containers next to the real `mybot-*` ones. Added `-p mybot` to the
  compose command in `server.js:259` so the project name is deterministic
  regardless of working directory.

---

# MyBot — Session Handoff (2026-04-11, evening)

## What changed this session (the headline)

The bot was crashing every time it tried to fix or add a feature. Root cause:
the Dockerfile installed `docker.io` which on Debian 12 does **not** include the
`docker compose` v2 plugin. So when Claude tried `docker compose up -d --build`
per the system prompt, the command failed, and Claude improvised with
`docker stop mybot-claude-api-1 && docker run -d --name mybot-claude-api-1-new`
— which killed the container without rebuilding the image, dropped every
in-flight conversation, and brought back stale code under the wrong name.

Fixed end-to-end. The bot can now safely rebuild itself in a loop without
losing conversations or breaking, plus it has OpenClaw-grade loop detection
to catch runaway tool calls before they melt the session.

### Self-rebuild that survives the rebuild
- **Dockerfile** — installs the standalone `docker compose` v2 binary into
  `/usr/local/lib/docker/cli-plugins/`. Verified inside the container:
  `Docker Compose version v5.1.2`.
- **`POST /rebuild` endpoint** in `claude-api/server.js` — the **only**
  sanctioned rebuild path. It:
  1. Syntax-checks every `.js` file in `claude-api/` and refuses on failure
  2. Flushes pending channel-state writes
  3. Marks every busy channel for "I just rebuilt" notification (persisted
     via `wantsRestartNotification` flag in channel-state.json)
  4. Spawns a **host-side** `docker:cli` container that bind-mounts the
     docker socket and runs `docker compose up -d --build` from outside the
     dying container. This was the critical lesson: a `spawn(..., { detached: true })`
     from inside Docker gets SIGKILLed when the container dies regardless of
     `unref()`. The host-side rebuilder survives because it runs in its own
     PID namespace on the host.
  5. Returns JSON before being replaced
- **System prompt** in `bot.js` — strong, explicit prohibition on
  `docker stop|kill|rm|restart|run` against `mybot-*` containers. Single
  canonical instruction: `curl -X POST http://localhost:3400/rebuild`.
- **`HOST_PROJECT_PATH` env var** in docker-compose.yml — required because
  the docker daemon resolves bind-mounts on the host filesystem, not inside
  the calling container. Defaults to the WSL Windows path; override per env.
- **End-to-end tested**: hit `/rebuild`, got `{"ok":true,"syntaxChecked":33}`,
  watched `mybot-rebuilder-*` container start, replace claude-api, and the
  new container come back healthy in ~50s with all 9 channel states restored.

### Restart notification reaches every affected channel
- Auto-resume scan in `bot.js` now notifies any channel with **either** an
  `activeTask`, a non-empty `pendingQueue`, **or** a `wantsRestartNotification`
  flag. Previously only `activeTask` channels got notified — channels
  mid-conversation but pre-task were silent.
- New `buildRestartMessage()` helper produces context-aware text:
  "Back online — I just rebuilt myself, was working on X, resend if you
  didn't get an answer." vs "I'm back from an unexpected restart…"
- Signal and Discord both go through the same builder.

### Signal image attachments now reach Claude
- `adapters/signal.js` — `_handleIncoming` is now async, downloads each
  attachment via `GET /v1/attachments/{id}`, saves to
  `/tmp/signal-attachments/{ts}_{filename}` with proper extensions inferred
  from `contentType`, and passes `localPath` through `NormalizedMessage.attachments`.
- `bot.js` Signal handler — synthesizes a prompt block telling Claude
  "User attached N file(s)" with the local paths so Claude can `Read` them.
- `server.js` webhook — wraps the now-async `_handleIncoming` in
  `Promise.resolve(...).catch(...)` so a single bad envelope can't cause
  an unhandled rejection.

### Group mention enforcement
- Discord guild channels were already gated; confirmed working.
- Signal group mention check now matches by **both phone number and UUID**
  (signal-cli mention objects vary). Logs the rejection so you can see
  when it fires.
- `NormalizedMessage` now carries a `mentions` array.
- Note: bot's own UUID lookup isn't wired yet — phone-number match handles
  the common case. If you see a "bot not mentioned" log when you DID
  mention it, that's the gap to fix next.

### Tool-call loop detection (OpenClaw port)
- New `claude-api/loop-detection.js` (~330 LOC), JS port of OpenClaw's
  `tool-loop-detection.ts`. Three orthogonal detectors:

  | Detector | Threshold | Action |
  |---|---|---|
  | `generic_repeat` | 10 identical calls | warn |
  | `known_poll_no_progress` (e.g. `BashOutput`) | 10 / 20 | warn / **kill** |
  | `ping_pong` (A→B→A→B with stable outcomes) | 10 / 20 | warn / **kill** |
  | `global_circuit_breaker` | 30 identical no-progress | **kill** |

- Wired into `bot.js` at three places:
  - `freshProgress()` initializes `loopState` per Claude run
  - `tool_use` handler calls `recordToolCall` + `detectToolCallLoop`.
    Critical → kills child + sends `🛑 Loop blocked` to channel. Warning →
    sends `⚠️ ...` once per pattern (deduped via `lastLoopWarningKey`).
  - `tool_result` handler calls `recordOutcomeById` to stamp the result hash
    so the no-progress detectors can tell "same result" from "different result".
- Removed the old 16-line `detectLoop()` helper and `toolSignatures` field —
  strictly inferior.
- All four detectors smoke-tested before wiring (`generic_repeat`,
  `known_poll_no_progress`, `ping_pong`, healthy-mixed → no false positive).
- Module loads successfully inside the running container.

## Current status
- **Discord** (`BiancaDaCow#3914`) — live, healthy
- **Signal** (`+15106412088`) — live, healthy, **`MODE=json-rpc` + webhook** (~5x faster than the previous `MODE=normal` polling setup)
- Both run from a single `mybot-claude-api` container; signal-cli runs in the `mybot-signal-api` sidecar
- Bring up: `docker compose --profile signal up -d --build`
- Tear down: `docker compose --profile signal down`
- **Self-rebuild from Claude:** `curl -X POST http://localhost:3400/rebuild` (the ONLY sanctioned path; never use `docker stop|kill|rm|restart|run` against `mybot-*`)

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

# Self-rebuild — absolute host path to the project root. The /rebuild
# endpoint spawns a host-side `mybot-rebuilder-*` container that bind-mounts
# this path so it can run `docker compose up -d --build` from outside the
# dying claude-api container.
HOST_PROJECT_PATH=/mnt/c/Users/karen/Desktop/Github Projects/MyBot
```

## Known issues

### Pending-invite Signal groups can't be auto-joined
Three groups (`Beep`, `boop`, `Bianca & Booboo`) show the bot in `pending_invites`. signal-cli's `updateGroup -g` (the v2 invite-accept path) throws `"Cannot find service ID for self to accept invite"` on standalone-registered accounts. This happens in BOTH `MODE=normal` and `MODE=json-rpc` — switching modes doesn't fix it.

**Workaround in place:** `!joingroup <invite-link>` command. The user generates a Signal group invite link (group settings → group link → enable + share), pastes it to Bianca, and the bot joins via signal-cli's `joinGroup --uri` (a different code path that bypasses the bug). Implementation: `claude-api/adapters/signal.js:joinGroupByLink()` shells out via `docker exec` into signal-api and calls a Python one-liner that connects to the local JSON-RPC daemon on port 6001.

**Real fix (deferred):** onboard the bot as a *linked device* of a primary phone Signal install instead of registering it standalone. This is what OpenClaw does. Requires setting up Signal on a phone or emulator using `+15106412088`, which the user doesn't currently have. See deep-research report at `~/.claude/plans/logical-noodling-sun-agent-aaa46579895eda2ac.md` for the full diagnosis.

### bbernhard silently swallows JSON-RPC errors
`POST /v1/groups/.../join` returns `204 No Content` even when the underlying `updateGroup` JSON-RPC call fails. Our adapter now verifies actual membership after the call and logs honestly: `Join call returned 204 for "X" but bot is still pending invite — ...`

## Testing checklist for next session

### High-priority live verification (this session's work)
- [ ] **`/rebuild` from Claude end-to-end** — ask Bianca from Discord to make
      any small code edit and rebuild. She should: (1) edit, (2) tell you
      she's rebuilding, (3) call POST /rebuild, (4) NOT run `docker stop`
      or `docker run`. Container should come back healthy in ~50s and the
      conversation should keep going.
- [ ] **Restart-notification covers all channels** — start a conversation
      in Channel A, then trigger a rebuild while a conversation is also
      active in Channel B (no `activeTask` yet, just a fresh message).
      Both should receive a "Back online — I just rebuilt myself…" notice.
- [ ] **Signal image pipeline** — send a JPG/PNG to Bianca on Signal and
      ask "what's in this image". She should `Read` the file from
      `/tmp/signal-attachments/` and describe it. (Previously she replied
      "Image didn't come through — just a placeholder character.")
- [ ] **Loop detection — known poll** — get Bianca into a stuck poll loop
      (e.g. start a long-running bash via `Bash` then have her hammer
      `BashOutput`). After ~10 identical no-progress polls she should warn,
      after ~20 she should self-kill with a `🛑 Loop blocked` message.
- [ ] **Loop detection — ping-pong** — give her a task that makes her
      alternate between two tools forever (e.g. "keep checking X then
      editing Y until Z"). Same warn/critical thresholds.
- [ ] **Loop detection — no false positives** — make her do a normal
      multi-step build (read 5 files, edit 3, run tests). She should get
      to a clean finish with no `⚠️` or `🛑` messages.
- [ ] **Signal mention in group** — `@Bianca what's up` in a Signal group
      she's a member of, confirm she replies. Send a non-mention message
      in the same group, confirm she stays silent (logs should show
      "Group message — bot not mentioned").

### Older verification still pending
- [ ] **TikTok transcript pipeline** — send a TikTok URL with "tldr" via
      Signal, confirm Bianca summarizes the actual spoken content.
- [ ] **Conversational onboarding** — message Bianca from a phone number
      that's NOT in `user-profiles.json` and NOT the owner. Confirm the
      3-step wizard runs.
- [ ] **Group member context / "plan for us"** — small group of onboarded
      users with connected calendars, ask "when can we 3 grab dinner".
- [ ] **Read-only enforcement** — non-owner Signal account asks for an
      edit; confirm Edit tool is unavailable.
- [ ] **`!joingroup`** — get a real Signal invite link, paste it,
      confirm `signal-cli listGroups -d` shows `Active: true`.
- [ ] **Signal auto-resume** — start long task on Signal, `docker compose
      restart claude-api`, confirm "I'm back" message arrives.

### Edge cases worth probing
- [ ] Onboarding wizard + `!status` mid-flow — does a normal `!command`
      mid-wizard escape cleanly?
- [ ] Non-owner `!loop "edit X"` from Signal — should bail gracefully
      because `--disallowedTools` blocks Edit.
- [ ] Long Whisper transcripts (>3500 chars) truncation quality.
- [ ] **Loop detection w/ sub-agents** — spawn 3+ sub-agents that each
      hit the loop threshold; the parent's loopState is shared, so the
      first sub-agent to trip should kill the whole session. Verify
      this is the desired behaviour or whether sub-agents need their
      own loopState.
- [ ] **`/rebuild` with broken syntax** — intentionally edit a file to
      have a syntax error, hit /rebuild. Should return
      `{ok:false, error:"Syntax errors found", details:[...]}` and NOT
      kill the running container.

## Known issues

### Pending-invite Signal groups can't be auto-joined
Three groups (`Beep`, `boop`, `Bianca & Booboo`) show the bot in
`pending_invites`. signal-cli's `updateGroup -g` (the v2 invite-accept
path) throws `"Cannot find service ID for self to accept invite"` on
standalone-registered accounts. **Workaround:** `!joingroup
<invite-link>` command. **Real fix (deferred):** linked-device onboarding.

### bbernhard silently swallows JSON-RPC errors
`POST /v1/groups/.../join` returns `204 No Content` even when the
underlying call fails. Adapter now verifies actual membership after
the call.

### ~~Signal mention by UUID is best-effort only~~ — FIXED
`SignalAdapter._loadSelfInfo()` now queries `/v1/identities/{phoneNumber}`
at startup, finds the row where `number === phoneNumber`, and caches the
`uuid` as `this._selfUuid`. Verified live: startup logs now print
`[signal] Self UUID resolved: e69a86a8-c394-4852-92f4-d4ba6b06fb72`.
Group @-mentions that reference the bot by UUID now match.

### ~~Loop detection state is per-session, not per-sub-agent~~ — FIXED
Each sub-agent spawned via the `Agent` tool now gets its own
`loopState` stored on its `activeAgents` entry. The `tool_use` and
`tool_result` handlers in `bot.js` route loop-detection calls via
`agentObj ? agentObj.loopState : channelState.progress.loopState`,
where `agentObj` is looked up from `parent_tool_use_id`. Sub-agents
can no longer pollute each other's sliding windows.

## Future work (deferred)

### OpenClaw architectural recommendations
Deep-research report at `/home/karen/.claude/plans/logical-noodling-sun-agent-aaa46579895eda2ac.md`.
Status of the top 5 ports:

1. ~~**Port `tool-loop-detection.ts`**~~ — **DONE this session.** See
   `claude-api/loop-detection.js` + wiring at `bot.js:freshProgress()`,
   `tool_use` handler, and `tool_result` handler.
2. **Heartbeat-wake coalesce/priority scheduler** with `requests-in-flight`
   skip. Source: `/tmp/openclaw/src/infra/heartbeat-wake.ts`. Target:
   `claude-api/heartbeat.js`.
3. **Replace `!loop` done-detection with a wrapper-tolerant `LOOP_COMPLETE`
   token strip** — copies the `HEARTBEAT_OK` pattern from
   `auto-reply/heartbeat.ts:124-185`.
4. **Supervisor module with `scopeKey` + `replaceExistingScope` + dual
   timers** — extract from `bot.js:askClaude()` into
   `claude-api/supervisor.js`. Eliminates the `state.process` /
   `_userStopped` / `busy` dance and makes `!stop` a one-liner.
5. **Channel adapter contract tests** — one suite run against both Discord
   and Signal adapters.

### SQLite migration of `tasks-storage.js`
Originally listed as `task-ledger.js`, but `task-ledger.js` turned out
to be dead code (nothing requires it). The actively-used file with the
same crash-mid-write risk is `tasks-storage.js` (`briefing-tasks.json`).
Move it to `better-sqlite3` (Node 20 doesn't have built-in `node:sqlite`)
with per-task upserts. Low effort, eliminates corruption-on-crash. May
also delete `task-ledger.js` outright since it's never imported.

### "Tap to onboard" hint in groups
The conversational onboarding wizard only runs in 1:1 DMs. When an
unknown user posts in a group, the bot should send them a hint to DM
directly for setup.

### Linked-device Signal onboarding
Proper fix for pending-invite groups. Requires a phone or Android
emulator with Signal installed using `+15106412088`. Once linked, all
the `acceptInvite` paths will work because the local account store
will have the self ACI/PNI populated via sync messages from the primary.
