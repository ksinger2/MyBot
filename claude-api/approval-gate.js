'use strict';

/**
 * approval-gate.js — Deterministic server-side approval system for dangerous actions.
 *
 * The bot CANNOT execute certain actions (unsubscribe, add-to-cart, delete, etc.)
 * unless the user has explicitly approved through a numbered approval flow.
 * Approvals are checked server-side in the tag handler, NOT in the LLM prompt.
 *
 * In-memory Map with TTL. No file I/O, no external dependencies.
 */

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Map<string, { actions: Array<{id, type, label, meta, approved, consumed}>, createdAt: number }>
// Key format: `${userId}:${type}`
const store = new Map();

function _key(userId, type) {
  return `${userId}:${type}`;
}

/**
 * Read entry from store, enforcing TTL. Returns null if expired or missing.
 */
function _getEntry(userId, type) {
  const key = _key(userId, type);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry;
}

/**
 * Store a list of pending actions for user approval.
 * Replaces any existing pending set for this user+type.
 *
 * @param {string} userId
 * @param {string} type - Action category (e.g. 'unsub', 'cart', 'delete')
 * @param {Array<{label: string, meta: object}>} actions
 * @returns {Array<{id: number, label: string, meta: object, approved: boolean}>}
 */
function proposePending(userId, type, actions) {
  const key = _key(userId, type);
  const numbered = actions.map((a, i) => ({
    id: i + 1,
    label: a.label,
    meta: a.meta || {},
    approved: false,
    consumed: false,
  }));
  store.set(key, { actions: numbered, createdAt: Date.now() });
  // Return without the internal `consumed` field
  return numbered.map(({ consumed, ...rest }) => rest);
}

/**
 * Get all pending actions for a user+type. Returns null if expired or none.
 *
 * @param {string} userId
 * @param {string} type
 * @returns {Array<{id: number, label: string, meta: object, approved: boolean}>|null}
 */
function getPending(userId, type) {
  const entry = _getEntry(userId, type);
  if (!entry) return null;
  return entry.actions.map(({ consumed, ...rest }) => rest);
}

/**
 * Approve action(s) by number, 'all', or label substring match.
 *
 * @param {string} userId
 * @param {string} type
 * @param {number|string} idOrKeyword - Action ID (number), 'all', or label substring
 * @returns {{ approved: number[], notFound: boolean }}
 */
function approvePending(userId, type, idOrKeyword) {
  const entry = _getEntry(userId, type);
  if (!entry) return { approved: [], notFound: true };

  const approved = [];

  if (idOrKeyword === 'all') {
    for (const action of entry.actions) {
      action.approved = true;
      approved.push(action.id);
    }
  } else if (typeof idOrKeyword === 'number') {
    const action = entry.actions.find(a => a.id === idOrKeyword);
    if (action) {
      action.approved = true;
      approved.push(action.id);
    }
  } else if (typeof idOrKeyword === 'string') {
    const needle = idOrKeyword.toLowerCase();
    for (const action of entry.actions) {
      if (action.label.toLowerCase().includes(needle)) {
        action.approved = true;
        approved.push(action.id);
      }
    }
  }

  return { approved, notFound: approved.length === 0 };
}

/**
 * Server-side check called by the tag handler before executing a dangerous action.
 * Returns the meta object if an approved+unconsumed match exists, or null.
 * Each approval can only be consumed ONCE.
 *
 * @param {string} userId
 * @param {string} type
 * @param {function(object): boolean} matchFn - Predicate against action.meta
 * @returns {object|null} The meta object, or null if no valid approval
 */
function consumeApproval(userId, type, matchFn) {
  const entry = _getEntry(userId, type);
  if (!entry) return null;

  const action = entry.actions.find(a => a.approved && !a.consumed && matchFn(a.meta));
  if (!action) return null;

  action.consumed = true;
  return { ...action.meta };
}

/**
 * Clear all pending actions for a user+type.
 *
 * @param {string} userId
 * @param {string} type
 */
function clearPending(userId, type) {
  store.delete(_key(userId, type));
}

module.exports = {
  proposePending,
  getPending,
  approvePending,
  consumeApproval,
  clearPending,
};
