# MyBot — Next Steps

## What's Working
- **SDK fast-path (all non-owner chats)**: Non-owner DMs and group chats go to Haiku/Sonnet via SDK directly. No CLI spawn, no API key rate limit risk for non-owner messages.
- **Non-owner CLI permanently blocked**: Non-owner users can never trigger a CLI spawn. `[NEEDS_AGENT]` responses are blocked + forwarded to Karen.
- **Karen's OAuth account fully isolated**: No non-owner session ever touches `~/.claude.json`. `HOME=/home/node-nonowner` for all non-owner contexts.
- **Action tags work for all users**: `[EVENT:]`, `[REMIND:]`, `[CALENDAR:]`, `[WEATHER:]`, `[IMAGINE:]`, etc. fully processed for SDK responses via synthetic result path.
- **Orphan cleanup on startup**: `pkill -f "^claude "` runs at bot startup, followed immediately by clearing all persisted sessionIds — no more "No conversation found" errors after container restart.
- **Scheduled tasks — no CLI spawns**:
  - `briefings.js` (morning + weekly preview): Haiku SDK — all data pre-fetched, no web search needed
  - `ai-news.js`: SerpAPI direct fetch + Haiku SDK formatting — deterministic, no CLI
  - `media-pulse.js`: SerpAPI direct fetch + Haiku SDK formatting
  - `scheduler.js` dm-task: `askClaude()` with `ownerDmMode: true` (Karen's OAuth, not API key)
  - `scheduler.js` task: `runClaudeWithContinuation()` with `ownerDmMode: true`
  - `queue-runner.js`: `ownerDmMode: true` (already was)
- **`[WEATHER:]`/`[CALENDAR:]` tag resolution**: `resolveTagsInText()` in scheduler.js resolves these tags directly via weather plugin + internal API before `sendLongMessage()` — no raw tags in morning briefing.
- **ANTHROPIC_API_KEY usage**: Only `chat-responder.js` (non-owner SDK DMs). All scheduled tasks and Karen's messages use OAuth.
- **Full feature access for all users**: USER MODE — all users can use calendar, weather, 8sleep, Gmail, reminders, images, memories, product search. Only code/file editing blocked for non-owners.
- **`!ownergroup` command**: Registers groups for owner-mode CLI access.
- **Signal-only**: Discord fully removed. Signal via bbernhard/signal-cli-rest-api (MODE=json-rpc + webhook).
- **Email digest** (`!emaildigest`): Morning email digest via Gmail — categorizes, marks read, supports unsubscribe. Schedulable daily.

## Routing Table
| Who | Route | Auth |
|-----|-------|------|
| Karen's DM | CLI (Opus, no limits) | OAuth `~/.claude.json` |
| Karen's `!ownergroup` chats | CLI (Opus, full tools) | OAuth `~/.claude.json` |
| Anyone else — DM or group (conversational) | Haiku/Sonnet SDK | `ANTHROPIC_API_KEY` |
| Anyone else — [NEEDS_AGENT] | BLOCKED + forwarded to Karen | — |
| Scheduled tasks (dm-task, task) | CLI with `ownerDmMode: true` | OAuth `~/.claude.json` |
| Scheduled tasks (briefings, ai-news, media-pulse) | Haiku SDK | `ANTHROPIC_API_KEY` (cheap, no rate limit risk) |

## What's Broken / In Progress
- **Signal group join broken**: Auto-join via API returns 204 but bot stays "pending invite" — signal-cli cannot find its own service ID. Groups must be invited manually.
- **SDK history lost on rebuild**: Per-channel Sonnet history is in-memory only. Rebuild = conversation reset for non-owner users. Acceptable for now.
- **`!prefs` command**: Let users view/edit stored preference rules (SET_PREF). Not yet implemented.
- **Email digest — needs re-auth**: Karen must run `!connect` once to re-authorize Google with the `gmail.modify` + `gmail.send` scopes.
- **Weekly preview web search**: Haiku SDK can't do WebSearch — weekly preview uses training knowledge for "week ahead" context instead of real-time search. Acceptable tradeoff to eliminate CLI spawn.

## Next Steps (Prioritized)
1. **Re-authorize Google for Gmail**: Karen runs `!connect` → completes OAuth flow → `!emaildigest` to test.
2. **Validate morning briefing**: Wait for next 9am/10am fire or `!briefing` — confirm weather + calendar show actual data (not raw tags), confirm no `[runner]` log entry.
3. **Validate AI Pulse**: Confirm SerpAPI fetch works, no CLI spawn in logs.
4. **Validate Merrisa's calendar**: Have Merrisa send "put an event for tonight at 8pm" — confirm event goes to her Google Calendar, no rate limit hit.
5. **Persist SDK history in channel state**: Survive rebuilds without conversation reset.
6. **`!prefs` command**: Show user their stored preference rules.
7. **WhatsApp adapter**: User wants Bianca on WhatsApp (explicitly NOT iMessage).
