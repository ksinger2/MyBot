# MyBot — Next Steps

## What Was Done (2026-04-12)

### Per-project Signal permissions
- `project-permissions.js` — owner hardcoded to `+16315214787`, per-project permissions in `.claude/permissions.json`
- `!permit` command — owner-only, grants a phone number access to current project
- Signal handler enforces read-only mode for non-owner, non-permitted DMs

### User profile system
- `user-profiles.js` — AES-256-GCM encrypted profiles keyed by phone number
- Stores: name, location, timezone, Google Calendar connection, preferences (50 cap)
- `buildProfileContext()` injects profile into Claude system prompt
- `/setup/:userId` endpoint — phone-friendly onboarding web page

### Signal group chat fixes
- **`!listen on` broken** — was calling `getChannel(msg.chatId)` without the `signal:` prefix, so `listenToAll` was always read from a blank state. Fixed to use `state.listenToAll` directly (state already loaded with correct key).
- **`@Mention !command` routing** — strip `@mention` prefix before command check so `@Bianca !listen on` routes to command handler, not Claude.
- **Pre-rebuild Signal notification** — `/rebuild` endpoint now sends "🔄 Rebuilding myself — back in ~30 seconds" to all active Signal chats before going down.

### Turn limit fixes
- `error_max_turns` subtype no longer throws "Claude CLI exited with code 1" — resolved as `hitTurnLimit: true` so continuation works normally
- Owner Signal DM gets 200 turns (`SIGNAL_OWNER_MAX_TURNS` env override, default 200)
- Group chats capped at 5 turns

## Known Issues / To Do
- Group members can't self-onboard from group chat — they must DM the bot directly to run `!setup`
- Signal group calendar coordination (`/event` endpoint) needs real-world testing

## Priorities
1. Test `!listen on` in Family Assisted group — state key bug fixed, should work now
2. Test `!permit` flow for granting access to a project
3. Monitor for any edge cases with the `error_max_turns` continuation
