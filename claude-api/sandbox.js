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
const { execSync } = require('child_process');
const { atomicWriteJsonSync } = require('./atomic-write');

const SANDBOX_FILE = path.join('/app/data', 'sandbox-users.json');
const SANDBOX_ROOT = '/sandbox';
const DEFAULT_TOOLS = 'Edit,Write,Read,Bash,WebSearch,WebFetch,Grep,Glob,Task,TodoWrite';

let _cache = null;
const _uidCache = new Map();

function _load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(SANDBOX_FILE, 'utf8'));
  } catch {
    _cache = {};
  }
  return _cache;
}

function _save(config) {
  _cache = config;
  atomicWriteJsonSync(SANDBOX_FILE, config);
}

function _linuxUserName(name) {
  return 'sandbox-' + name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

function _getUid(linuxUser) {
  if (_uidCache.has(linuxUser)) return _uidCache.get(linuxUser);
  try {
    const uid = parseInt(execSync(`id -u ${linuxUser}`, { encoding: 'utf8' }).trim(), 10);
    _uidCache.set(linuxUser, uid);
    return uid;
  } catch {
    return null;
  }
}

/**
 * Provision a Linux user for sandboxing: create user, home dir, workspace dir,
 * copy OAuth credentials. Idempotent — safe to call multiple times.
 */
function provisionUser(entry) {
  const { linuxUser, cwd } = entry;

  // Create Linux user if it doesn't exist
  try {
    execSync(`id ${linuxUser}`, { stdio: 'ignore' });
  } catch {
    execSync(`sudo /usr/sbin/useradd --no-create-home --shell /bin/bash --home-dir /home/${linuxUser} ${linuxUser}`, {
      stdio: 'ignore',
    });
    console.log(`[sandbox] Created Linux user: ${linuxUser}`);
  }

  // Create home directory with .claude subdir
  const homeDir = `/home/${linuxUser}`;
  execSync(`sudo /usr/bin/mkdir -p ${homeDir}/.claude`, { stdio: 'ignore' });

  // Copy owner's OAuth credentials so sandbox user can authenticate.
  // .claude.json = settings, .claude/.credentials.json = actual OAuth token.
  try {
    execSync(`sudo /usr/bin/cp /home/node/.claude.json ${homeDir}/.claude.json`, { stdio: 'ignore' });
  } catch (err) {
    console.warn(`[sandbox] Could not copy .claude.json for ${linuxUser}: ${err.message}`);
  }
  try {
    execSync(`sudo /usr/bin/cp /home/node/.claude/.credentials.json ${homeDir}/.claude/.credentials.json`, { stdio: 'ignore' });
  } catch (err) {
    console.warn(`[sandbox] Could not copy .credentials.json for ${linuxUser}: ${err.message}`);
  }

  // Set ownership of home directory
  execSync(`sudo /usr/bin/chown -R ${linuxUser}:${linuxUser} ${homeDir}`, { stdio: 'ignore' });

  // Create workspace directory and set ownership
  execSync(`sudo /usr/bin/mkdir -p ${cwd}`, { stdio: 'ignore' });
  execSync(`sudo /usr/bin/chown -R ${linuxUser}:${linuxUser} ${cwd}`, { stdio: 'ignore' });

  // Ensure /sandbox parent has restrictive permissions (root-owned, 755)
  // so sandbox users can traverse but not write to other users' dirs
  try {
    execSync(`sudo /usr/bin/chown root:root ${SANDBOX_ROOT}`, { stdio: 'ignore' });
    execSync(`sudo /usr/bin/chmod 755 ${SANDBOX_ROOT} 2>/dev/null || true`, { stdio: 'ignore', shell: true });
  } catch {}

  console.log(`[sandbox] Provisioned ${linuxUser} → ${cwd}`);
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
  const entry = config[senderId];
  if (!entry) return null;

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
  const cwd = cwdOverride || path.join(SANDBOX_ROOT, name);

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
  addSandboxUser,
  removeSandboxUser,
  listSandboxUsers,
  provisionAll,
  provisionUser,
  SANDBOX_ROOT,
  DEFAULT_TOOLS,
};
