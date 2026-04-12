# MyBot — Session Handoff (2026-04-12)

## Discord streaming, Signal read receipts, crash notification, cleanup

### Discord streaming (new)
Responses now stream live to Discord using message editing instead of
waiting for Claude to finish and sending the full response at once.

- Uses `ChannelProxy.fromDiscordStreaming()` — edits a single message
  as text arrives (debounced every 2s to respect Discord rate limits)
- Shows a trailing `█` cursor while generating, removed on completion
- When text exceeds 1800 chars, finalizes current message and starts new
- Image attachments sent separately after streaming completes
- `streamReplies: true` passed to runner, same flag Signal already uses

**Files changed:**
- `claude-api/bot.js` — new `fromDiscordStreaming()` static method on
  `ChannelProxy`; Discord message handler now uses streaming proxy with
  `streamReplies: true`; `sendLongMessage()` guarded by `!result.streamed`

### Signal read receipts (new)
Bot now sends a read receipt (blue double-check) when it receives a
Signal DM, so the sender knows their message was received.

- `sendReadReceipt(senderId, timestamp)` method on `SignalAdapter`
- Calls `POST /v1/receipts/{number}` on signal-cli-rest-api
- Fire-and-forget, best-effort — doesn't block message handling
- Only for DMs (not groups — Signal doesn't support group read receipts)

**Files changed:**
- `claude-api/adapters/signal.js` — new `sendReadReceipt()` method
- `claude-api/bot.js` — calls `sendReadReceipt()` on message receive

### Crash notification via Signal (new)
On unexpected restart (crash, container kill), the bot sends the owner
a Signal DM: "Bot restarted unexpectedly (possible crash). I'm back
online now." Clean `!restart` and rollback restarts don't trigger it.

**Files changed:**
- `claude-api/bot.js` — after `signalAdapter.start()`, checks clean
  shutdown file; sends notification to `SIGNAL_OWNER` if unclean

### Rebuild announcement removed
The broadcast of "I'm back" messages to ALL channels after a rebuild
was removed — it was annoying users in channels that weren't even
talking to the bot.

- `wantsRestartNotification` flag no longer set during `/rebuild`
- Auto-resume still notifies channels with actual interrupted work
  (activeTask or pendingQueue) — that's crash recovery, not spam
- System prompt no longer tells Claude to announce rebuilds

**Files changed:**
- `claude-api/server.js` — removed `wantsRestartNotification` marking
- `claude-api/bot.js` — removed `wantsRestartNotification` from filter
- `claude-api/system-prompt.js` — removed rebuild announcement instruction

### Pending events persisted to disk
Group pending events (`_pendingGroupEvents` Map) now save to
`/app/data/pending-events.json` on every mutation and load on startup.
Expired events (>24h) are still swept hourly.

**Files changed:**
- `claude-api/server.js` — `_savePendingEvents()` helper, load on
  startup, save after `/event`, `/event/join`, and sweep

### BOT_PUBLIC_URL fix
Three files were using `PUBLIC_URL` or falling back to `localhost:3400`
instead of the `BOT_PUBLIC_URL` env var defined in docker-compose.yml.

**Files changed:**
- `claude-api/commands/setup.js`
- `claude-api/google-auth.js`
- `claude-api/wizards/onboarding.js`

### Google OAuth — published but unverified
OAuth consent screen published (was "Testing" which blocked non-test
users). Users will see a "Google hasn't verified this app" warning —
click Advanced → Go to app (unsafe). One-time per user. Full
verification skipped (requires multi-week review, not worth it for
personal use).

### Remaining improvements (not blockers)
- WhatsApp adapter not started
- Signal group joins still failing ("Cannot find service ID for self")
  — needs re-linking bot as a linked device of a primary phone
- SIGNAL_OWNER_NUMBER not set in .env (using hardcoded fallback)

---

## Previous: `!listen` toggle + better video link fallback

### `!listen` command
Per-channel toggle that controls whether the bot responds to every message
in a group chat or only to @mentions and !commands.

- `!listen` — flip-flop toggle
- `!listen on` — respond to all group messages
- `!listen off` — mentions-only (default)
- Aliases: `!listenall`, `!listening`
- Works on both Signal and Discord
- Persisted across restarts via `channel-persistence.js`

### Better video link fallback (TikTok/Instagram/YouTube)
When yt-dlp fails (IP-blocked, geo-restricted, etc.), the bot now has a
multi-tier fallback instead of just saying "couldn't pull the video":

1. **OG tags** — TikTok links now fetch both oEmbed AND OG meta tags in
   parallel. OG tags often contain the full video caption/description that
   oEmbed omits.
2. **Browser screenshot** — prompt now instructs Claude to use Playwright
   `browser_navigate` + `browser_screenshot` to view the actual page and
   describe the visual content.
3. **WebSearch** — last resort, with stronger instructions to identify the
   specific content (exact recipe, exact topic) rather than vague guesses.
4. **Anti-vagueness rule** — "vague guesses like 'likely a recipe based on
   their content style' are NOT acceptable" added to response rules.
