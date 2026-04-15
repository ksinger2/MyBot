/**
 * internal-token.js — Single source of truth for the bot-side
 * INTERNAL_API_TOKEN closure.
 *
 * SECURITY MODEL (H2 — deterministic auth hardening):
 *
 * The shared secret used for bot→internal-API authentication MUST NOT be
 * visible to Claude CLI subprocesses. Previously `INTERNAL_API_TOKEN` lived
 * in `process.env`, which meant:
 *   (a) runner.js passed it to the Claude child explicitly, and
 *   (b) any child-process spawned after `delete process.env.INTERNAL_API_TOKEN`
 *       would still inherit it unless we explicitly scrubbed the var.
 *
 * This module captures the token into a closure at load time (before anything
 * else requires it), then **deletes it from `process.env`** so no downstream
 * code — not Claude, not any future spawn — can read it back. Bot-side code
 * accesses the token only via `getInternalToken()`.
 *
 * The closure is the ONLY handle. If you find yourself writing
 * `process.env.INTERNAL_API_TOKEN` anywhere, you are bypassing this layer.
 */

// Capture once at module load. This runs before any spawn() because we
// require() this module from bot.js/server.js at the top of their files.
const _CAPTURED = process.env.INTERNAL_API_TOKEN || '';

// Hard-scrub from process.env so child processes (and Claude's Bash tool,
// via process inheritance) cannot read it. Safe to do unconditionally —
// the captured copy is retained in this module's closure.
if (process.env.INTERNAL_API_TOKEN) {
  delete process.env.INTERNAL_API_TOKEN;
}

/**
 * Returns the internal API token (closure-stored). Never reads from env.
 * @returns {string} the token, or '' if unset
 */
function getInternalToken() {
  return _CAPTURED;
}

module.exports = { getInternalToken };
