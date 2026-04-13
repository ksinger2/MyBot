/**
 * image-context.js — Shared per-session image attachment context
 *
 * Bot.js sets the current image path before spawning Claude for a message
 * that has image attachments. The /imagine endpoint reads and consumes it
 * automatically if inputImagePath is absent in the request body.
 *
 * This makes image-to-image deterministic — Claude never needs to pass
 * inputImagePath; the server always has the right context.
 */

let _current = null;

module.exports = {
  /**
   * Register an image attachment for the current session.
   * @param {string} imagePath  Absolute path to the downloaded attachment
   * @param {number} [ttlMs]    How long to keep it (default 10 minutes)
   */
  set(imagePath, ttlMs = 10 * 60 * 1000) {
    _current = { imagePath, expiresAt: Date.now() + ttlMs };
  },

  /**
   * Consume the current image context (read once, then clear).
   * Returns null if nothing is set or it has expired.
   * @returns {string|null}
   */
  consume() {
    if (!_current) return null;
    if (Date.now() > _current.expiresAt) { _current = null; return null; }
    const p = _current.imagePath;
    _current = null; // consume — don't leak into subsequent requests
    return p;
  },

  /**
   * Peek without consuming (useful for debugging / logging).
   * @returns {string|null}
   */
  peek() {
    if (!_current) return null;
    if (Date.now() > _current.expiresAt) { _current = null; return null; }
    return _current.imagePath;
  },

  /** Explicitly clear (call when session ends without /imagine being used). */
  clear() {
    _current = null;
  },
};
