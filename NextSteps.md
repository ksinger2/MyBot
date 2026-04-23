# MyBot — Next Steps

## Current State
Branch: `stable-rebuild` (based on 959564f + 3 cherry-picks)

## What's Working
- **Signal-only architecture**: Discord fully removed. Signal via bbernhard/signal-cli-rest-api.
- **Owner DM**: Full Claude Code CLI (Opus, OAuth via ~/.claude.json, unlimited turns, all tools)
- **Non-owner DM / Groups**: CLI with Sonnet, readOnly or tool whitelist, turn-capped
- **Voice pipeline**: STT/TTS, Siri endpoint at /voice
- **All plugins**: weather, calendar, product search, concert tracker, EightSleep, Spotify
- **Action tags**: [EVENT:], [REMIND:], [CALENDAR:], [WEATHER:], [IMAGINE:], [EIGHTSLEEP:], [PRODUCT:], [LEARNED:], [SET_PREF:], etc. — all processed server-side
- **Email digest** (`!emaildigest`): Gmail read, categorize, mark read, unsubscribe via Haiku
- **Privacy hardening**: PII filters, INTERNAL_API_TOKEN protection, MCP blocking for non-owners
- **Session journal**: Per-channel CLI session summaries, injected into next session's system prompt

## What Needs Work (Prioritized)

### P0 — CLI Process Management
1. **Raise MAX_CONCURRENT from 1 to 4** — allow multiple simultaneous conversations
2. **Process registry** — track all active CLI processes (pid, channelId, startedAt, isOwner)
3. **Priority semaphore** — owner gets priority, can evict oldest non-owner if all slots full
4. **Queue timeout feedback** — non-owners waiting >30s get "busy, try again" instead of silent queue
5. **Ghost reaper** — 60s interval, kill non-owner processes >15min, clean up dead PIDs
6. **Startup orphan cleanup** — kill lingering claude processes from previous container runs

### P0 — Align Non-Owner DMs with Groups
- Non-owner DMs currently: readOnly=true, no tool whitelist, maxTurns=50, no personality
- Should match groups: readOnly=false, tool whitelist (Read,WebSearch,WebFetch,Task,TodoWrite), maxTurns=8, personality applied

### P0 — Conversation Context Persistence
- **Recent message log**: Store last 10 messages per channel in channel state (persisted across rebuilds). Inject as prefix on CLI startup so bot always knows what was just discussed.
- **Session journal**: Already exists and injects last 3 session summaries. Verify it's working on this branch.

### P1 — Future
- Re-authorize Google for Gmail (`!connect` → OAuth flow → `!emaildigest`)
- `!prefs` command for user preference rules
- WhatsApp adapter (explicitly NOT iMessage)
- Selective security hardening from commit 67e7054 (non-owner tool restrictions without full routing rewrite)
- Selective process management from commit d64d200 (ghost cleanup without blanket CLI blocking)

## Routing Table
| Who | Route | Auth |
|-----|-------|------|
| Karen's DM | CLI (Opus, unlimited) | OAuth `~/.claude.json` |
| Non-owner DM | CLI (Sonnet, 8 turns, tool whitelist) | `ANTHROPIC_API_KEY` |
| Group chat | CLI (Sonnet, 8 turns, tool whitelist) | `ANTHROPIC_API_KEY` |

---

## Implementation Plan — CLI Process Management + Context Persistence

### Background
- Branch: `stable-rebuild` (based on 959564f + cherry-picks of 56c5630, c0ada73, 2e2f1d6)
- Bianca IS Claude Code CLI — owner gets full abilities (edit, bash, git, loops, etc.)
- Non-owners get CLI too, just sandboxed (tool whitelist, 8-turn cap, Sonnet)
- All features (calendar, weather, TikTok, reminders, images, etc.) work via server-side action tag processing — not dependent on CLI vs SDK

### Change 1: Raise MAX_CONCURRENT to 4 (`runner.js`)
- Change default: `parseInt(process.env.MAX_CONCURRENT_CLAUDE, 10) || 4`
- 4 concurrent Sonnet sessions stays under Anthropic's ~50 RPM rate limit
- Owner (Opus) has separate rate limits, shares the pool

### Change 2: Process Registry (`runner.js`)
- Add module-level Map: `const _processRegistry = new Map(); // pid → {channelId, startedAt, isOwner, child}`
- Register at spawn (~line 491 where `channelState.process = child`)
- Deregister in close handler (~line 890) and all kill paths
- Enables ghost detection, priority eviction, diagnostics

### Change 3: Priority Semaphore (`runner.js`, replace lines 66-94)
- `_acquireSlot(isOwner)` — owner requests get priority
- **Owner at capacity**: evict oldest non-owner process (forceKillProcess), free slot
- **Non-owner at capacity**: queue with 30-second timeout → reject with `SlotTimeoutError`
- `_releaseSlot()` — wake owner waiters first, then FIFO for non-owners

### Change 4: Queue Timeout Feedback (`bot.js`, ~line 1617-1625)
- Catch `SlotTimeoutError` in dispatch path
- Send: "I'm handling a few conversations right now — try again in a minute"
- No silent infinite queue

### Change 5: Ghost Reaper (`runner.js`)
- `_sweepGhosts()` on 60-second setInterval
- Kill non-owner processes older than 15 minutes
- Kill processes whose PID no longer exists (`process.kill(pid, 0)` throws)
- Force-release semaphore slot on kill
- Owner processes exempt (have their own 90-min hard timeout)

### Change 6: Startup Orphan Cleanup (`runner.js` + `bot.js`)
- Export `killOrphanClaude()` — kills lingering claude processes from previous runs
- Call from bot.js during initialization, before `startAllSchedules()`

### Change 7: Align Non-Owner DMs with Groups (`bot.js`, ~line 2148-2178)
| Setting | Non-owner DM (now) | Group (now) | Target |
|---------|-------------------|-------------|--------|
| readOnly | true | false | false |
| groupAllowedTools | undefined | Read,WebSearch,WebFetch,Task,TodoWrite | Read,WebSearch,WebFetch,Task,TodoWrite |
| maxTurns | ~50 (default) | 8 | 8 |
| personality | none | applied | applied |

### Change 8: Conversation Context Persistence (`bot.js` + `runner.js`)

**Layer A — Recent Message Log (new)**
- Add `state.recentMessages` array to channel state (persisted via channel-persistence.js)
- On every incoming message: push `{role: 'user', text, sender, timestamp}`, cap at 10
- On every outgoing bot response: push `{role: 'assistant', text, timestamp}`, cap at 10
- In runner.js, inject into first human message as prefix:
  ```
  [Recent conversation in this chat:]
  User (2min ago): hey what's the weather
  Bianca (2min ago): It's 72° and sunny in LA...
  User (now): what about tomorrow?
  ```

**Layer B — Session Journal (already exists)**
- `session-journal.js` writes per-channel summaries after each CLI session
- `getJournalContext(channelId)` injects last 3 sessions into system prompt (runner.js:362)
- Verify functioning on stable-rebuild branch — no changes needed if so

### Files to Modify
| File | Changes |
|------|---------|
| `claude-api/runner.js` | Process registry, priority semaphore, ghost reaper, orphan cleanup, MAX_CONCURRENT=4 |
| `claude-api/bot.js` | Align non-owner DM config, queue timeout feedback, startup orphan call, pass isOwner to Runner, recent message log |

### Verification
1. `docker compose up -d --build`
2. Check logs — orphan cleanup runs on startup
3. Owner DM: full CLI response with personality
4. Non-owner DM: tool whitelist, 8-turn cap, personality
5. Concurrent: owner + non-owner simultaneously — both get responses
6. Capacity: all 4 slots full → non-owner gets "busy" after 30s, owner evicts oldest non-owner
7. Ghost: reaper logs every 60s, no stale processes accumulate
8. Context: send 3 messages, wait for CLI to close, send 4th — bot references prior messages
