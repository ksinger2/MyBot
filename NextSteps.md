# MyBot — Next Steps

## What's Working
- **SDK fast-path (all non-owner chats)**: Non-owner DMs and group chats go to Sonnet via `ANTHROPIC_API_KEY`. No CLI spawn for conversational messages. Owner DMs and owner groups always use CLI + OAuth.
- **Action tag escalation**: Any Sonnet response containing `[EVENT:]`, `[REMIND:]`, `[CALENDAR:]`, `[WEATHER:]`, `[IMAGINE:]`, `[EIGHTSLEEP:]`, `[PRODUCT:]`, `[LEARNED:]`, `[SET_PREF:]`, `[UPDATE_NOTES:]`, `[REBUILD]`, `[FLIGHT:]`, `[CONCERT_PRICES:]` auto-escalates to CLI via API key — never OAuth.
- **Karen's OAuth account is fully isolated**: No non-owner session ever touches `~/.claude.json`. CLI escalations for non-owners use `ANTHROPIC_API_KEY`.
- **Full feature access for all users**: USER MODE (blocklist) — all users can use calendar, weather, 8sleep, Spotify, Gmail, reminders, images, memories, product search. Only code/file editing blocked for non-owners.
- **Correct event dates**: Current date+time (America/Los_Angeles) injected into every Sonnet SDK message so "tonight at 8pm" resolves correctly.
- **Cross-invitation bug fixed**: Calendar events no longer invite Karen when someone else creates one. Each event goes to the requesting user's own Google Calendar.
- **`!ownergroup` command**: `!ownergroup add` in any group registers it for full owner-mode CLI access (Opus, no turn limit, no @mention required for Karen). Non-owners in owner groups still need @mention and get restricted tools.
- **Security**: Non-owners in owner groups cannot bypass @mention or get unrestricted tools — only the owner sender gets that bypass.
- **Rate limit notification**: Immediate "⏳ Hit an API rate limit" message instead of silent stall.
- **`!status` command**: Shows busy state, queue depth, elapsed time, cost.
- **Queue ack**: DM senders see "⏳ Queued (#N)" when Bianca is busy.
- **Signal-only**: Discord fully removed. Signal via bbernhard/signal-cli-rest-api (MODE=json-rpc + webhook).
- **Email digest** (`!emaildigest`): Morning email digest via Gmail — categorizes last 24h emails into Important / Needs Reply / Unsubscribe / Ignore using Claude Haiku. Supports mark-read, mark-unread, and one-click unsubscribe (RFC 8058 POST → GET → mailto: fallback). Schedulable daily (e.g. `!emaildigest schedule 8am`). Owner-only. SSRF-protected.

## Routing Table
| Who | Route | Auth |
|-----|-------|------|
| Karen's DM | CLI (Opus, no limits) | OAuth `~/.claude.json` |
| Karen's `!ownergroup` chats | CLI (Opus, full tools) | OAuth `~/.claude.json` |
| Anyone else — DM or group (conversational) | Sonnet SDK | `ANTHROPIC_API_KEY` |
| Anyone else — action tag or [NEEDS_AGENT] | CLI (Sonnet, restricted tools) | `ANTHROPIC_API_KEY` |

## What's Broken / In Progress
- **"opts is not defined" signal handler error**: Intermittent ReferenceError thrown inside `_dispatchSignalMessage`. Couldn't find the source via static analysis — all known `opts` usages are properly scoped. Added `console.error(err.stack)` to the catch block (bot.js:3152) so the next occurrence will log the exact line in docker logs. Check with: `docker compose logs claude-api 2>&1 | grep "Stack:"`.
- **Signal group join broken**: Auto-join via API returns 204 but bot stays "pending invite" — signal-cli cannot find its own service ID. Groups must be invited manually.
- **SDK history lost on rebuild**: Per-channel Sonnet history is in-memory only. Rebuild = conversation reset for non-owner users. Acceptable for now; fix by persisting history in channel state.
- **`!prefs` command**: Let users view/edit stored preference rules (SET_PREF). Not yet implemented.
- **Email digest — needs re-auth**: Karen must run `!connect` once to re-authorize Google with the new `gmail.modify` + `gmail.send` scopes before `!emaildigest` will work.

## Next Steps (Prioritized)
1. **Fix "opts is not defined"**: Trigger the error, grab the stack trace from docker logs, fix the underlying bug.
2. **Re-authorize Google for Gmail**: Karen runs `!connect` → completes OAuth flow → `!emaildigest` to test.
3. **Schedule daily digest**: `!emaildigest schedule 8am` once Gmail is connected.
4. **Validate Merrisa's calendar**: Have Merrisa send "put an event for tonight at 8pm" — confirm event goes to her Google Calendar (merrisang13@gmail.com), date is correct, no CLI rate limit hit.
5. **Persist SDK history in channel state**: Survive rebuilds without conversation reset.
6. **`!prefs` command**: Show user their stored preference rules.
7. **WhatsApp adapter**: User wants Bianca on WhatsApp (explicitly NOT iMessage).
