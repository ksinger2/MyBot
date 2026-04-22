# MyBot — Next Steps

## What's Working

### Routing
| Who | Route | Auth |
|-----|-------|------|
| Karen's DM | CLI (Opus, no limits) | OAuth `~/.claude.json` |
| Karen's `!ownergroup` chats | CLI (Opus, full tools) | OAuth `~/.claude.json` |
| Non-owner DM or group (conversational) | Haiku-class SDK fast-path | `ANTHROPIC_API_KEY` |
| Non-owner — [NEEDS_AGENT] | BLOCKED + rate-limited forward to Karen (1/min/user) | — |
| Scheduled dm-task / task | CLI with `ownerDmMode: true` | OAuth `~/.claude.json` |
| Briefings, AI news, media pulse | Haiku SDK | `ANTHROPIC_API_KEY` (tiny, no rate limit risk) |

### Rate Limits — Deployed and Live
- `ANTHROPIC_API_KEY` is now used ONLY for small SDK calls (≤250 tokens output, Haiku)
- Zero CLI spawns touch the API key — all CLI uses Karen's OAuth
- Non-owner fast-path: Haiku with 6-turn history, 1400-char profile cap, 2500-char input cap
- Non-owner CLI permanently blocked; `[NEEDS_AGENT]` blocked + rate-limited forwarding to Karen
- Video transcripts (TikTok/Instagram) capped at 1500 chars to prevent token bloat

### Calendar — No Karen Leakage
- All calendar events go through `/event` endpoint → `getCalendarClient(userId)` per user → each person's own OAuth token
- Karen's phone is never auto-added to any event
- For DMs: `uids = {sender only}`, deterministically enforced in code
- Old bug (CLI using Karen's Google Calendar MCP via `HOME=/home/node`) is structurally blocked — non-owners can never reach CLI
- If a user hasn't connected Google Calendar, they get a "connect first" message — Karen's calendar is untouched

### Orphan Cleanup
- `pkill -f "^claude "` runs at every startup (bot.js:911)
- All persisted sessionIds cleared at startup (`channel-persistence.js`)
- 5-minute audit interval kills any CLI running >2 hours (runner.js)
- Webhook message dedup prevents duplicate processing from Signal retries

### Action Tags (Non-Owner)
- SDK response with `[EVENT:]`, `[REMIND:]`, `[CALENDAR:]`, `[WEATHER:]`, `[IMAGINE:]`, etc. falls through to tag handlers via synthetic result — no CLI needed
- Non-owner SDK now receives enriched link data (TikTok transcripts, link metadata) — not just raw text
- `[WEATHER:]` and `[CALENDAR:]` in scheduled task output resolved via `resolveTagsInText()` before `sendLongMessage()`
- URLs in listenToAll group chats are no longer silently filtered out

### Signal Bot
- Signal-only (Discord fully removed)
- Morning briefing, AI Pulse, Media Pulse all run via SerpAPI + Haiku SDK — deterministic, no Claude CLI
- `!ownergroup` command registers groups for owner-mode CLI access
- Email digest (`!emaildigest`): categorizes Gmail, supports mark-read + unsubscribe

### Security Hardening (This Session)
- `SIGNAL_OWNER_NUMBER` no longer has a hardcoded phone number fallback — fails fast if env var not set
- `[NEEDS_AGENT]` forwarding rate-limited to 1 per user per 60s to prevent spam flooding
- Webhook dedup added to Signal adapter (timestamp+source key, 60s window)
- INTERNAL_API_TOKEN properly scrubbed from env before child process spawns (verified)
- Calendar privacy: group chats only see "Busy", full details only in DMs (deterministic server-side override)

## Known Limitations
- **Signal group join broken**: Auto-join returns 204 but bot stays "pending invite" — signal-cli can't find its own service ID. Groups must be invited manually.
- **SDK history lost on rebuild**: Non-owner per-channel SDK history is in-memory only — resets on container restart.
- **Weekly preview**: No real-time web search (Haiku SDK can't use WebSearch tools) — uses training knowledge for "week ahead" context.
- **`!prefs` command**: View/edit stored preference rules (SET_PREF) — not yet implemented.

## Token Savings Opportunities (Not Yet Implemented)
- **Heartbeat pre-check** (~2.88M tokens/month): Add regex pre-scan before invoking Claude; 80% of heartbeats return NO_ACTION_NEEDED
- **Group member context caching** (~375K tokens/month): Cache per-group for 1hr instead of rebuilding on every message
- **Greeting detection earlier** (~15-30K tokens/month): Move `GREETING_RE` check before full context building
- **Profile context sent once per session** (~50-100K tokens/month): Don't re-inject on every SDK history reset

## Next Steps (Prioritized)
1. **Validate Bianca DM rate limits**: Send a few normal non-owner messages and confirm Anthropic 429s stop.
2. **Re-authorize Google for Gmail**: Karen runs `!connect` → completes OAuth → `!emaildigest` to test.
3. **Validate morning briefing**: Confirm weather + calendar show actual data (no raw tags), no `[runner]` log entry on next fire.
4. **Validate AI Pulse**: Confirm SerpAPI fetch works and news arrives without CLI spawn in logs.
5. **Validate Merrisa's calendar**: Have Merrisa create an event — confirm it goes to her Google Calendar, not Karen's, no rate limit hit.
6. **Implement heartbeat pre-check**: Biggest token savings (~2.88M/month) — regex scan AGENTS.md for actionable keywords before invoking Claude.
7. **Persist SDK history**: Survive rebuilds without non-owner conversation reset.
8. **`!prefs` command**: Show user their stored preference rules.
9. **WhatsApp adapter**: Bianca on WhatsApp (explicitly NOT iMessage).
