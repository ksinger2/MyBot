# Work Queue

The manager loop picks the top unblocked task. When you act on one, mark it `[DONE]`, `[BLOCKED: reason]`, or `[IN_PROGRESS: what's left]`. Add new items as you discover them.

## Tasks

- [ ] Verify the Discord and Signal adapters fully implement the `MessagePlatform` interface in `adapters/base.js` — fill any methods that still throw `not implemented`
- [ ] Write end-to-end tests for emoji reaction handling (👍/👎) on Signal — `NextSteps.md` flags this as not yet confirmed working
- [ ] Add integration tests for group UUID resolution and persistence across rebuilds — `NextSteps.md` flags potential UUID-map loading issues
- [ ] Add unit tests for any pure helpers in `adapters/` (parsers, formatters)
- [ ] Document the bot's command set / message-routing flow in CLAUDE.md
- [ ] Audit `.env.example` for completeness against `process.env` references in the codebase

## Notes

Do not send real messages to real Discord or Signal accounts as part of any test. Use mocked clients or a test channel only if explicitly configured.
