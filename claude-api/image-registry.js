/**
 * image-registry.js — Per-session image tracking (input + output)
 *
 * Replaces image-context.js with a per-chatId registry that tracks both:
 *   - Input images (user attachments set by bot.js before spawning Claude)
 *   - Output images (generated files registered by /imagine after creation)
 *
 * This makes image delivery fully deterministic:
 *   - bot.js calls setInput() when the user attaches an image
 *   - /imagine calls consumeInput() to get the attachment (even if Claude omits inputImagePath)
 *   - /imagine calls addOutput() after writing the generated image
 *   - bot.js calls getOutputs() post-session to send images as attachments
 *   - No prompt compliance required at any step
 */

const fs = require('fs');

const _sessions = new Map();
// Last output per chat — survives session end() so refinement works across turns
const _lastOutputs = new Map(); // chatId → { imagePath, timestamp }
const LAST_OUTPUT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const _auditLog = []; // rolling log of last 30 entries for debugging
const MAX_AUDIT = 30;
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

function _audit(action, chatId, imagePath) {
  _auditLog.push({
    action,
    chatId,
    imagePath,
    timestamp: new Date().toISOString(),
  });
  if (_auditLog.length > MAX_AUDIT) _auditLog.shift();
}

function _getOrCreate(chatId) {
  if (!_sessions.has(chatId)) {
    _sessions.set(chatId, {
      inputs: [],
      outputs: [],
      startedAt: Date.now(),
      expiresAt: Date.now() + DEFAULT_TTL_MS,
    });
  }
  const s = _sessions.get(chatId);
  // Refresh TTL on every access
  s.expiresAt = Date.now() + DEFAULT_TTL_MS;
  return s;
}

module.exports = {
  /**
   * Register the user's attached image before spawning Claude.
   * Called by bot.js when an image attachment is downloaded.
   */
  setInput(chatId, imagePath) {
    const s = _getOrCreate(chatId);
    s.inputs.push(imagePath);
    _audit('setInput', chatId, imagePath);
    console.log(`[image-registry] setInput(${chatId.substring(0, 12)}...): ${imagePath}`);
  },

  /**
   * Consume the first queued input image for this session.
   * Called by /imagine to auto-inject the user's attachment.
   * Returns null if no input is queued.
   */
  consumeInput(chatId) {
    const s = _sessions.get(chatId);
    if (!s || s.inputs.length === 0) return null;
    if (Date.now() > s.expiresAt) { _sessions.delete(chatId); return null; }
    const p = s.inputs.shift();
    _audit('consumeInput', chatId, p);
    return p;
  },

  /**
   * Register a generated image output.
   * Called by /imagine after writing the image file to disk.
   */
  addOutput(chatId, imagePath) {
    const s = _getOrCreate(chatId);
    s.outputs.push(imagePath);
    // Track last output separately — survives session end() for cross-turn refinement
    _lastOutputs.set(chatId, { imagePath, timestamp: Date.now() });
    _audit('addOutput', chatId, imagePath);
    console.log(`[image-registry] addOutput(${chatId.substring(0, 12)}...): ${imagePath}`);
  },

  /**
   * Get all generated image paths for this session.
   * Called by bot.js post-session to send as attachments.
   * Does NOT consume — call end() to clean up.
   */
  getOutputs(chatId) {
    const s = _sessions.get(chatId);
    if (!s) return [];
    if (Date.now() > s.expiresAt) { _sessions.delete(chatId); return []; }
    return [...s.outputs];
  },

  /**
   * Clean up session state. Called in bot.js finally block.
   */
  end(chatId) {
    _sessions.delete(chatId);
  },

  /**
   * Get the most recently generated image for this chat (survives session end).
   * Used for iterative refinement — user says "make the glasses bigger" and
   * Claude uses this as inputImagePath without the user re-attaching.
   * Returns null if expired (15 min) or file no longer exists.
   */
  getLastOutput(chatId) {
    const entry = _lastOutputs.get(chatId);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > LAST_OUTPUT_TTL_MS) {
      _lastOutputs.delete(chatId);
      return null;
    }
    if (!fs.existsSync(entry.imagePath)) {
      _lastOutputs.delete(chatId);
      return null;
    }
    return entry.imagePath;
  },

  /**
   * Find the chatId with an active session (fallback for when chatId
   * can't be determined from the /imagine request). Returns the most
   * recently active session's chatId, or null.
   */
  findActiveChatId() {
    let latest = null;
    const now = Date.now();
    for (const [cid, s] of _sessions) {
      if (now > s.expiresAt) continue;
      if (!latest || s.startedAt > latest.startedAt) {
        latest = { chatId: cid, startedAt: s.startedAt };
      }
    }
    return latest ? latest.chatId : null;
  },

  /**
   * Get the audit log (last 30 entries) for debugging.
   */
  getAuditLog() {
    return [..._auditLog];
  },

  /**
   * Sweep expired sessions (call periodically or on demand).
   */
  sweep() {
    const now = Date.now();
    for (const [cid, s] of _sessions) {
      if (now > s.expiresAt) _sessions.delete(cid);
    }
  },
};
