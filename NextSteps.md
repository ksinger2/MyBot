# MyBot — Next Steps

## What's Working
- **Background jobs are AI-free**: AI Pulse (5x/day), Media Pulse (3x/day), Morning Briefing (1x/day), Weekly Preview (1x/week) all use pure RSS feeds and template formatting. Zero Claude sessions consumed. Eliminates 9+ OAuth sessions/day that were causing rate limits.
- **Morning briefing includes email digest**: Categorized emails (important, needs-reply, unsubscribe) using rule-based classification. Falls back to Haiku when API credits are available.
- **Deterministic Gmail access**: `email-search-cli.js` uses bot's own Google OAuth tokens with multi-strategy search (by name, email, subject). System prompt directs Claude to use this instead of MCP tools.
- **Deterministic Calendar access**: `calendar-cli.js` uses bot's own Google OAuth tokens. System prompt directs Claude to use this instead of MCP tools in owner DM.
- **Group chat calendar/weather/product tags**: `[CALENDAR:]`, `[WEATHER:]`, `[PRODUCT:]` tags now documented in system prompt so Claude knows to use them in group chats and non-owner DMs.
- **Server-side email endpoints**: `/email/search`, `/email/thread`, `/email/draft` for reliable email operations.
- **Turn limit**: Group chats and non-owner DMs get 20 turns (was 8). Enough for real conversations with tool calls.
- **Conversation memory**: Last 20 messages × 1000 chars (was 10 × 500). Better follow-up context across sessions.
- **Signal watchdog**: Auto-restarts signal-api on health check failure.
- **Process leak prevention**: Session expiry orphan kill, bg task tracking, graceful shutdown, 2h owner process cap.
- **Security hardening**: No hardcoded creds, XSS fixes, PII scrubbed from logs, rebuild dedup, per-user rate limiting, input validation on /setup forms.
- **Per-user rate limiting**: Non-owner users capped at 5 sessions per 15 minutes. Owner unlimited.
- **Message queue overflow protection**: Queue capped at 10 per channel, drops oldest when full.
- **Graceful shutdown**: queue-runner timers use .unref() so Node exits cleanly.

## What's Broken / Known Issues
- **Yahoo Finance rate-limiting**: Stocks section in morning briefing returns empty when Yahoo returns 429. Transient — works on retry. Could switch to a different stock data provider.
- **Anthropic API key has no credits**: Email digest AI categorization falls back to rule-based. Not a blocker — rules work fine.
- **Stale webhook detection**: Was removed from signal-watchdog.js by linter. Only HTTP health check remains. The watchdog detects full signal-api crashes but not silent WebSocket staleness.
- **Group chat calendar is post-session**: `[CALENDAR:]` tag results are sent as a follow-up message after the Claude session ends. Claude can't synthesize the calendar data (e.g., "you're free Tuesday afternoon") — it just triggers the fetch and the raw data appears separately.

## Next Steps
1. **Calendar tag as pre-fetch**: Consider injecting calendar data INTO the prompt (like briefings do) instead of post-session tag processing, so Claude can reason about availability
2. **Richer group chat context**: Session journal summaries are shallow — consider storing conversation summaries per group for better multi-session continuity
3. **Stock data provider**: Evaluate alternatives to yahoo-finance2 that don't rate-limit Docker IPs (Alpha Vantage free tier, or direct Yahoo Finance v8 API)
4. **Stale webhook detection**: Re-add the webhook staleness check to signal-watchdog.js (track lastWebhookAt vs a configurable threshold)
5. **RSS feed monitoring**: Verify feeds return content consistently; some may block or rate-limit over time
6. **Session resumption persistence**: Session IDs stored in memory only — lost on container restart. Consider persisting to disk.
7. **CSRF token replay prevention**: Add used-token tracking (low priority — internal network only)
8. **OAuth redirect validation**: Validate redirect targets against allowlist on OAuth callbacks
