# MyBot — Next Steps

## What Was Done (2026-04-13)

### Message grouping debounce
- Consecutive messages from the same user within 2.5s are combined before dispatching to Claude
- `MESSAGE_GROUP_DELAY_MS=2500` constant (set to 0 to disable)
- `shouldGroupImmediately()` — skips buffering for messages ending with punctuation or >120 chars
- `groupingTimer`, `groupingBuffer`, `groupingSenderId` added to channel state
- `_dispatchDiscordMessage()` and `_dispatchSignalMessage()` extracted as shared dispatch functions
- Timer cleanup added to `!stop` and `!kill`

### TikTok & Instagram transcript extraction
- `tiktok-transcript.js` — primary: extracts `subtitleInfos` VTT URLs from TikTok page HTML (mobile UA); fallback: yt-dlp + OpenAI Whisper
- `instagram-transcript.js` — Whisper-only (Instagram burns captions into video); also extracts og:description
- Both injected into bot.js for Discord and Signal handlers
- TikTok redirect following fixed to support multi-hop short URLs (tiktok.com/t/...)

### Rate limit handling
- `runner.js` now detects `rate_limit_event` from Claude CLI and notifies user instead of silently dying

### !rules command
- `commands/rules.js` — `!rules list`, `!rules add <rule>`, `!rules remove <keyword>`
- Rules stored in user profile, injected as "STRICT USER RULES" block in system prompt
- Rules card added to `/setup` page with add/remove UI
- `user-profiles.js` — `addRule()` (cap 20, 200 char limit), `removeRule()` (keyword match)

### !remember perspective fix
- UUID replacement before name flip so @uuid references don't survive into saved facts
- Debug logging added (to remove once confirmed fixed in prod)

### !btw improvements
- When bot is idle: shows background tasks from internal registry
- When bot is busy: shows background tasks at the bottom too
- Background task registry in `server.js` with `POST/DELETE/GET /internal/background-task(s)` endpoints

### Briefing improvements
- No sources list at bottom — links are inline only
- News sources: prefers wired.com, theverge.com, reuters.com via `site:` search operators
- Briefing config: added explicit Reuters and Verge/Wired topic queries

### AI Pulse schedule
- Changed from `0 8,11,14,17 * * *` to `0 8,11,14,17,20 * * *` — fires 8am, 11am, 2pm, 5pm, 8pm Pacific, nothing overnight

### Emoji reactions (👍/👎)
- Discord: `messageReactionAdd` handler — 👍=yes, 👎=no dispatched to Claude
- Discord: `GuildMessageReactions` intent + `Partials.Message/Reaction` added
- Signal: `dataMessage.reaction` detection in `_handleIncoming` — emits `'reaction'` event
- Signal: `sendReaction()` method added to SignalAdapter
- Both platforms: track last bot message ID/timestamp so reactions only apply to bot's last message

### Message deletion cancels tasks
- Discord: `messageDelete` event — cancels grouping timer, removes from queue, or kills active process
- Signal: `remoteDelete` detection — same logic via `messageDelete` event
- Queue entries tagged with `_messageId` (Discord) / `_timestamp` (Signal)
- Channel state tracks `_triggeredByMessageId` and `_triggeredByTimestamp`

### Signal group UUID resolution fix
- Group member list was filtering to `+` prefix only — UUID members silently dropped
- Fixed: resolve UUID→phone via `_resolveRecipient` before filtering
- If unresolved UUIDs remain, trigger `_loadContacts()` on-demand before building context
- `_loadContacts()` now runs on a 5-minute timer (not just on startup) so newly onboarded users appear in group context without restart
- Group context now injects `[INTERNAL]` phone number map for event scheduling

### Pre-rebuild announcement removed
- No more "🔄 Rebuilding myself" broadcast to all Signal channels before rebuild

## Known Issues / To Do
- Emoji reaction test (👍/👎 on bot message) not yet confirmed working end-to-end — Karen couldn't test in-session
- Debug logging in `remember.js` should be removed once perspective-flip bug confirmed fixed
- Group members can still only self-onboard by DMing the bot directly (not from group chat)
- Cloudflare Tunnel runs as a host process — consider docker-compose sidecar for resilience

## Priorities
1. Test 👍/👎 reaction handling end-to-end
2. Confirm group UUID resolution works for Merrisa (next group message should pick her up)
3. Remove debug logs from `remember.js` once flip bug confirmed fixed
4. Test Google Calendar OAuth end-to-end via `mybot.backtoirl.com`
</content>
</invoke>