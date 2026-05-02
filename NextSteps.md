# MyBot — Next Steps

## What's Working
- System prompt shrunk ~70% (724→248 words owner, 388→246 non-owner) — less token burn per session
- Rate limit handling fixed — `rate_limit_event` is routine, no longer false-alarms or kills sessions; silent retry with 60s backoff on genuine failures
- Signal UUID→phone resolution across entire pipeline (sandbox, profiles, reactions, dispatch)
- Semaphore slot leak protection (try/catch on spawn, .catch() on all dispatch call sites)
- [BACKGROUND] and [REBUILD] tag security gates (owner-only)
- 105 regression tests run at Docker build time (approval gate, tags, UUID, security, semaphore, greeting)
- Browser automation via Playwright MCP with persistent profile (`/app/data/browser-profile`)
- Deterministic purchase prevention: Playwright wrapper blocks checkout/payment URLs at JSON-RPC level
- Newsletter unsubscribe analysis + conversational approval flow (`[EMAIL_UNSUB:]` tag + approval gate)
- Shopping cart approval gate (`[CART_ADD:]` tag — propose→confirm→execute, no purchase action exists)
- Extended `[SET_PREF:]` for email/shopping/notifications domains (not just events)
- User preferences injected into context memory (not system prompt) via `user-pref-context.js`
- `!unsub scan/yes/list/clear` command as power-user shortcut
- `!testas` command for owner to impersonate sandbox users
- Signal-api healthcheck fixed (wget→curl), autoheal removed from signal-api

## What's Broken / In Progress
- Amazon cart execution is stubbed — approval gate works but Playwright add-to-cart automation not yet wired (needs active browser session with login)
- Amazon login flow needs building (tunnel-based or cookie import for persistent auth)
- Batch email drafts (`batch-draft` CLI command) not yet built — single drafts work fine
- Newsletter analyzer depends on Gmail OAuth — only works for users with `!connect` completed

## Next Steps
- Build Amazon login persistence (Cloudflare tunnel for phone-based login, or cookie import)
- Wire Playwright cart automation into `[CART_ADD: action="add"]` handler
- Test unsubscribe flow end-to-end with real Gmail (owner sends "what should I unsubscribe from?")
- Test shopping flow end-to-end (owner asks Bianca to find products on Amazon)
- Consider adding email digest integration with unsubscribe suggestions (daily digest could flag candidates)
