/**
 * Per-project permission control — Signal only.
 *
 * The owner (+16315214787) always has full access.
 * Everyone else is read-only unless explicitly granted per-project access.
 * Permission changes can ONLY be made by the owner.
 *
 * Permissions stored in /workspace/<project>/.claude/permissions.json
 */

const fs   = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

// The one and only person who can edit code or change permissions from Signal
const SIGNAL_OWNER = process.env.SIGNAL_OWNER_NUMBER || '+16315214787';

function _permFile(projectPath) {
  return path.join(projectPath, '.claude', 'permissions.json');
}

function _read(projectPath) {
  try {
    const f = _permFile(projectPath);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}

function _write(projectPath, data) {
  const f = _permFile(projectPath);
  atomicWriteJsonSync(f, data);
}

/** Is this phone number the Signal owner? */
function isSignalOwner(phoneNumber) {
  return phoneNumber === SIGNAL_OWNER;
}

/**
 * Does this phone number have permission to interact with this project?
 * Owner always does. Others need an explicit entry in permissions.json.
 */
function hasProjectPermission(phoneNumber, projectPath) {
  if (isSignalOwner(phoneNumber)) return true;
  const perms = _read(projectPath);
  if (!perms) return false;
  return (perms.allowed || []).includes(phoneNumber);
}

/** Grant a phone number access to a project (owner only — enforced at call site). */
function grantPermission(phoneNumber, projectPath) {
  const perms = _read(projectPath) || { allowed: [] };
  if (!perms.allowed.includes(phoneNumber)) {
    perms.allowed.push(phoneNumber);
    _write(projectPath, perms);
  }
}

/** Revoke a phone number's access to a project (owner only — enforced at call site). */
function revokePermission(phoneNumber, projectPath) {
  const perms = _read(projectPath);
  if (!perms) return;
  perms.allowed = (perms.allowed || []).filter(p => p !== phoneNumber);
  _write(projectPath, perms);
}

/** List all phone numbers with explicit permission for a project. */
function listPermissions(projectPath) {
  const perms = _read(projectPath);
  const explicit = perms ? (perms.allowed || []) : [];
  // Owner is always included but stored separately (not in the file)
  return { owner: SIGNAL_OWNER, allowed: explicit };
}

module.exports = {
  SIGNAL_OWNER,
  isSignalOwner,
  hasProjectPermission,
  grantPermission,
  revokePermission,
  listPermissions,
};
