/**
 * Per-user sandbox configuration — maps Signal/Discord user IDs to isolated
 * working directories with configurable tool access.
 *
 * ISOLATION MODEL (deterministic, not prompt-based):
 * 1. Each sandbox user gets a dedicated Linux user (uid/gid)
 * 2. Their workspace lives on an ext4 Docker volume at /sandbox/<name>
 *    — chowned to their Linux user, so permissions are enforced by the OS
 * 3. Claude CLI spawns inside a mount namespace where /workspace is replaced
 *    with an empty, inaccessible tmpfs — sandbox users literally cannot see
 *    the owner's projects. See runner.js _spawnSandboxed().
 * 4. /sandbox parent dir is root:root 755 — sandbox users can traverse it
 *    but only write to their own subdirectory.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readEncryptedJson, writeEncryptedJson } = require('./encrypted-json');

const SANDBOX_FILE = path.join('/app/data', 'sandbox-users.json');
const SANDBOX_DOMAIN = 'mybot-sandbox-users';
const SANDBOX_ROOT = '/sandbox';
const DEFAULT_TOOLS = 'Edit,Write,Read,Bash,WebSearch,WebFetch,Grep,Glob,Task,TodoWrite';

let _cache = null;
const _uidCache = new Map();

function _load() {
  if (_cache) return _cache;
  try {
    _cache = readEncryptedJson(SANDBOX_FILE, SANDBOX_DOMAIN);
  } catch {
    _cache = {};
  }
  return _cache;
}

function _save(config) {
  _cache = config;
  writeEncryptedJson(SANDBOX_FILE, config, SANDBOX_DOMAIN);
}

function _linuxUserName(name) {
  return 'sandbox-' + name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

/**
 * Validate that a cwd path is safe: resolves under SANDBOX_ROOT, no shell metacharacters.
 * Throws if invalid.
 */
function _validateCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    throw new Error(`[sandbox] Invalid cwd: must be a non-empty string`);
  }
  const resolved = path.resolve(cwd);
  if (!resolved.startsWith(SANDBOX_ROOT + path.sep) && resolved !== SANDBOX_ROOT) {
    throw new Error(`[sandbox] cwd "${cwd}" resolves outside ${SANDBOX_ROOT}`);
  }
  if (/[;&|`$(){}]/.test(cwd)) {
    throw new Error(`[sandbox] cwd "${cwd}" contains shell metacharacters`);
  }
  return resolved;
}

function _getUid(linuxUser) {
  if (_uidCache.has(linuxUser)) return _uidCache.get(linuxUser);
  try {
    const uid = parseInt(execFileSync('/usr/bin/id', ['-u', linuxUser], { encoding: 'utf8' }).trim(), 10);
    _uidCache.set(linuxUser, uid);
    return uid;
  } catch {
    // Don't cache null — user may be provisioned later
    return null;
  }
}

/**
 * Provision a Linux user for sandboxing: create user, home dir, workspace dir,
 * copy OAuth credentials. Idempotent — safe to call multiple times.
 */
function provisionUser(entry) {
  const { linuxUser, cwd } = entry;

  // Validate cwd is safe before any shell operations
  const safeCwd = _validateCwd(cwd);

  // Create Linux user if it doesn't exist
  try {
    execFileSync('/usr/bin/id', [linuxUser], { stdio: 'ignore' });
  } catch {
    execFileSync('/usr/bin/sudo', ['/usr/sbin/useradd', '--no-create-home', '--shell', '/bin/bash', '--home-dir', `/home/${linuxUser}`, linuxUser], {
      stdio: 'ignore',
    });
    console.log(`[sandbox] Created Linux user: ${linuxUser}`);
  }

  // Create home directory with .claude subdir
  const homeDir = `/home/${linuxUser}`;
  execFileSync('/usr/bin/sudo', ['/usr/bin/mkdir', '-p', `${homeDir}/.claude`], { stdio: 'ignore' });

  // Copy owner's OAuth credentials so sandbox user can authenticate.
  // .claude.json = settings, .claude/.credentials.json = actual OAuth token.
  try {
    execFileSync('/usr/bin/sudo', ['/usr/bin/cp', '/home/node/.claude.json', `${homeDir}/.claude.json`], { stdio: 'ignore' });
  } catch (err) {
    console.warn(`[sandbox] Could not copy .claude.json for ${linuxUser}: ${err.message}`);
  }
  try {
    execFileSync('/usr/bin/sudo', ['/usr/bin/cp', '/home/node/.claude/.credentials.json', `${homeDir}/.claude/.credentials.json`], { stdio: 'ignore' });
  } catch (err) {
    console.warn(`[sandbox] Could not copy .credentials.json for ${linuxUser}: ${err.message}`);
  }

  // Set ownership of home directory
  execFileSync('/usr/bin/sudo', ['/usr/bin/chown', '-R', `${linuxUser}:${linuxUser}`, homeDir], { stdio: 'ignore' });

  // Create workspace directory and set ownership
  execFileSync('/usr/bin/sudo', ['/usr/bin/mkdir', '-p', safeCwd], { stdio: 'ignore' });
  execFileSync('/usr/bin/sudo', ['/usr/bin/chown', '-R', `${linuxUser}:${linuxUser}`, safeCwd], { stdio: 'ignore' });

  // Ensure /sandbox parent has restrictive permissions (root-owned, 755)
  // so sandbox users can traverse but not write to other users' dirs
  try {
    execFileSync('/usr/bin/sudo', ['/usr/bin/chown', 'root:root', SANDBOX_ROOT], { stdio: 'ignore' });
  } catch { /* ignore */ }
  try {
    execFileSync('/usr/bin/sudo', ['/usr/bin/chmod', '755', SANDBOX_ROOT], { stdio: 'ignore' });
  } catch { /* ignore */ }

  console.log(`[sandbox] Provisioned ${linuxUser} → ${safeCwd}`);
}

/**
 * Refresh a sandbox user's OAuth credentials from the live /home/node copy.
 * Called immediately before spawning a CLI session as the sandbox user, so
 * each invocation starts with the freshest token. Without this, sandbox creds
 * are frozen at provision time and break with 401 once the live token rotates.
 * Best-effort: failures are logged but do not block the spawn.
 */
function refreshCredentials(linuxUser) {
  if (!linuxUser || typeof linuxUser !== 'string' || !/^[a-z0-9_-]+$/i.test(linuxUser)) return;
  const src = '/home/node/.claude/.credentials.json';
  const dst = `/home/${linuxUser}/.claude/.credentials.json`;
  try {
    execFileSync('/usr/bin/sudo', ['/usr/bin/cp', src, dst], { stdio: 'ignore' });
    execFileSync('/usr/bin/sudo', ['/usr/bin/chown', `${linuxUser}:${linuxUser}`, dst], { stdio: 'ignore' });
    execFileSync('/usr/bin/sudo', ['/usr/bin/chmod', '600', dst], { stdio: 'ignore' });
  } catch (err) {
    console.warn(`[sandbox] refreshCredentials failed for ${linuxUser}: ${err.message}`);
  }
}

function refreshAllCredentials() {
  const config = _load();
  const seen = new Set();
  for (const entry of Object.values(config)) {
    if (!entry || !entry.linuxUser || seen.has(entry.linuxUser)) continue;
    seen.add(entry.linuxUser);
    refreshCredentials(entry.linuxUser);
  }
}

/**
 * Provision all sandbox users from config. Called at startup from entrypoint.
 */
function provisionAll() {
  const config = _load();
  const entries = Object.values(config);
  if (entries.length === 0) return;

  console.log(`[sandbox] Provisioning ${entries.length} sandbox user(s)...`);
  for (const entry of entries) {
    try {
      provisionUser(entry);
    } catch (err) {
      console.error(`[sandbox] Failed to provision ${entry.linuxUser}: ${err.message}`);
    }
  }
}

/**
 * Look up sandbox config for a sender ID (phone number or Discord ID).
 * Returns { name, cwd, allowedTools, linuxUser, uid } or null.
 */
function getSandboxUser(senderId) {
  if (!senderId) return null;
  const config = _load();
  let entry = config[senderId];
  // If senderId is a UUID, try resolving to phone via the signal UUID map
  if (!entry && !senderId.startsWith('+')) {
    try {
      const map = readEncryptedJson(path.join('/app/data', 'signal-uuid-phone.json'), 'mybot-signal-uuid-phone');
      const phone = map.byUuid?.[senderId]?.phone;
      if (phone) entry = config[phone];
    } catch {}
  }
  if (!entry) return null;

  // Validate cwd from persisted config before returning it
  try {
    _validateCwd(entry.cwd);
  } catch (err) {
    console.error(`[sandbox] Rejecting sandbox user ${senderId}: ${err.message}`);
    return null;
  }

  // Re-validate linuxUser from persisted JSON matches expected pattern
  if (!entry.linuxUser || !/^sandbox-[a-z0-9]{1,20}$/.test(entry.linuxUser)) {
    console.error(`[sandbox] Rejecting sandbox user ${senderId}: linuxUser "${entry.linuxUser}" fails validation`);
    return null;
  }

  return {
    name: entry.name,
    cwd: entry.cwd,
    allowedTools: entry.allowedTools || DEFAULT_TOOLS,
    linuxUser: entry.linuxUser,
    uid: _getUid(entry.linuxUser),
  };
}

/**
 * Add a sandbox user. Creates Linux user and workspace immediately.
 * @param {string} senderId — Signal phone number or Discord ID
 * @param {string} name — Display name (e.g., "Daniel")
 * @param {string} [cwdOverride] — Custom workspace path (default: /sandbox/<name>)
 * @param {string} [allowedTools] — Comma-separated tool list
 */
function addSandboxUser(senderId, name, cwdOverride, allowedTools) {
  const config = _load();
  const linuxUser = _linuxUserName(name);
  const cwd = _validateCwd(cwdOverride || path.join(SANDBOX_ROOT, name));

  const entry = {
    name,
    cwd,
    allowedTools: allowedTools || DEFAULT_TOOLS,
    linuxUser,
  };

  provisionUser(entry);

  config[senderId] = entry;
  _save(config);
  console.log(`[sandbox] Added sandbox: ${senderId} → ${name} (${cwd})`);
  return entry;
}

/**
 * Link a group chat to an existing sandbox user's workspace.
 * All members of the group get that sandbox's tools, cwd, and session persistence.
 */
function linkGroupChat(chatId, sandboxSenderId) {
  const config = _load();
  const entry = config[sandboxSenderId];
  if (!entry) throw new Error(`No sandbox user found for ${sandboxSenderId}`);
  if (!config._groupLinks) config._groupLinks = {};
  config._groupLinks[chatId] = { sandboxSenderId, linkedAt: Date.now() };
  _save(config);
  console.log(`[sandbox] Linked group ${chatId} → sandbox ${entry.name}`);
  return entry;
}

function unlinkGroupChat(chatId) {
  const config = _load();
  if (!config._groupLinks?.[chatId]) return null;
  const removed = config._groupLinks[chatId];
  delete config._groupLinks[chatId];
  _save(config);
  console.log(`[sandbox] Unlinked group ${chatId}`);
  return removed;
}

/**
 * Look up sandbox config for a group chat ID.
 * Returns the linked sandbox user's config or null.
 */
function getSandboxForChat(chatId) {
  if (!chatId) return null;
  const config = _load();
  const link = config._groupLinks?.[chatId];
  if (!link) return null;
  return getSandboxUser(link.sandboxSenderId);
}

function removeSandboxUser(senderId) {
  const config = _load();
  const entry = config[senderId];
  if (!entry) return null;
  delete config[senderId];
  _save(config);
  console.log(`[sandbox] Removed sandbox: ${senderId} (${entry.name})`);
  return entry;
}

function listSandboxUsers() {
  return _load();
}

module.exports = {
  getSandboxUser,
  getSandboxForChat,
  addSandboxUser,
  removeSandboxUser,
  linkGroupChat,
  unlinkGroupChat,
  listSandboxUsers,
  provisionAll,
  provisionUser,
  refreshCredentials,
  refreshAllCredentials,
  _getUid,
  SANDBOX_ROOT,
  DEFAULT_TOOLS,
};
