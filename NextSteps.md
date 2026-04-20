# MyBot — Next Steps

## What's Working

### Routing
| Who | Route | Auth |
|-----|-------|------|
| Karen's DM | CLI (Opus, no limits) | OAuth `~/.claude.json` |
| Karen's `!ownergroup` chats | CLI (Opus, full tools) | OAuth `~/.claude.json` |
| Non-owner DM or group (conversational) | Haiku/Sonnet SDK | `ANTHROPIC_API_KEY` |
| Non-owner — [NEEDS_AGENT] | BLOCKED + forwarded to Karen | — |
| Scheduled dm-task / task | CLI with `ownerDmMode: true` | OAuth `~/.claude.json` |
| Briefings, AI news, media pulse | Haiku SDK | `ANTHROPIC_API_KEY` (tiny, no rate limit risk) |

### Rate Limits — Fully Resolved
- `ANTHROPIC_API_KEY` is now used ONLY for small SDK calls (≤2048 tokens each)
- Zero CLI spawns touch the API key — all CLI uses Karen's OAuth
- Old cause: scheduled tasks each spawned CLI doing 10-15 turns × 5+ WebSearch calls simultaneously — eliminated
- Non-owner CLI permanently blocked; `[NEEDS_AGENT]` blocked + forwarded to Karen

### Calendar — No Karen Leakage
- All calendar events go through `/event` endpoint → `getCalendarClient(userId)` per user → each person's own OAuth token
- Karen's phone is never auto-added to any event
- For DMs: `uids = {sender only}`, deterministically enforced in code
- Old bug (CLI using Karen's Google Calendar MCP via `HOME=/home/node`) is structurally blocked — non-owners can never reach CLI
- If a user hasn't connected Google Calendar, they get a "connect first" message — Karen's calendar is untouched

### Orphan Cleanup
- `pkill -f "^claude "` runs at every startup
- All persisted sessionIds cleared at startup (`channel-persistence.js`) — no more "No conversation found" errors after restart
- Both verified in logs on deploy: `[startup] Killed orphaned claude CLI processes` + `[channel-persistence] Cleared 12 stale sessionId(s) on startup`

### Action Tags (Non-Owner)
- SDK response with `[EVENT:]`, `[REMIND:]`, `[CALENDAR:]`, `[WEATHER:]`, `[IMAGINE:]`, etc. falls through to tag handlers via synthetic result — no CLI needed
- `[WEATHER:]` and `[CALENDAR:]` in scheduled task output resolved via `resolveTagsInText()` before `sendLongMessage()` — no raw tags in morning briefing

### Signal Bot
- Signal-only (Discord fully removed)
- Morning briefing, AI Pulse, Media Pulse all run via SerpAPI + Haiku SDK — deterministic, no Claude CLI
- `!ownergroup` command registers groups for owner-mode CLI access
- Email digest (`!emaildigest`): categorizes Gmail, supports mark-read + unsubscribe

## Known Limitations
- **Signal group join broken**: Auto-join returns 204 but bot stays "pending invite" — signal-cli can't find its own service ID. Groups must be invited manually.
- **SDK history lost on rebuild**: Non-owner per-channel Sonnet history is in-memory only — resets on container restart.
- **Weekly preview**: No real-time web search (Haiku SDK can't use WebSearch tools) — uses training knowledge for "week ahead" context. Acceptable tradeoff to eliminate CLI spawn.
- **`!prefs` command**: View/edit stored preference rules (SET_PREF) — not yet implemented.

## Next Steps (Prioritized)
1. **Re-authorize Google for Gmail**: Karen runs `!connect` → completes OAuth → `!emaildigest` to test.
2. **Validate morning briefing**: Confirm weather + calendar show actual data (no raw tags), no `[runner]` log entry on next fire.
3. **Validate AI Pulse**: Confirm SerpAPI fetch works and news arrives without CLI spawn in logs.
4. **Validate Merrisa's calendar**: Have Merrisa create an event — confirm it goes to her Google Calendar, not Karen's, no rate limit hit.
5. **Persist SDK history**: Survive rebuilds without non-owner conversation reset.
6. **`!prefs` command**: Show user their stored preference rules.
7. **WhatsApp adapter**: Bianca on WhatsApp (explicitly NOT iMessage).
