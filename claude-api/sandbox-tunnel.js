/**
 * sandbox-tunnel.js — Manages a persistent Cloudflare named tunnel for sandbox
 * user subdomains. Each sandbox user gets a subdomain like daniel.backtoirl.com
 * that routes to whatever port they register via !subdomain.
 *
 * The tunnel runs continuously with a dynamic YAML config. When port mappings
 * change, the config is rewritten and the cloudflared process is restarted.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────────────
const TUNNEL_ID = '2ff0f7ff-417a-4a2a-92c7-039897719713';
const CREDENTIALS_FILE = `/home/node/.cloudflared/${TUNNEL_ID}.json`;
const CONFIG_PATH = '/tmp/sandbox-tunnel-config.yml';
const DOMAIN = 'backtoirl.com';
const MAX_RESTART_ATTEMPTS = 10;
const RESTART_COOLDOWN_MS = 5000; // Base for exponential backoff
const MAX_BACKOFF_MS = 300000;    // 5 minute cap
const STABILITY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ── State ────────────────────────────────────────────────────────────────────
const portMap = new Map(); // sandboxName (lowercase) → port number
let tunnelProcess = null;
let restartCount = 0;
let restartTimer = null;
let stabilityTimer = null;
let stopped = false; // true if max retries exceeded

// ── Config generation ────────────────────────────────────────────────────────

function buildConfigYaml() {
  const lines = [
    `tunnel: ${TUNNEL_ID}`,
    `credentials-file: ${CREDENTIALS_FILE}`,
    'ingress:',
  ];

  for (const [name, port] of portMap) {
    lines.push(`  - hostname: ${name}.${DOMAIN}`);
    lines.push(`    service: http://localhost:${port}`);
  }

  // Catch-all — required by cloudflared
  lines.push('  - service: http_status:404');

  return lines.join('\n') + '\n';
}

function writeConfig() {
  const yaml = buildConfigYaml();
  fs.writeFileSync(CONFIG_PATH, yaml, 'utf8');
  console.log(`[sandbox-tunnel] Config written to ${CONFIG_PATH} (${portMap.size} route(s))`);
}

// ── Process management ───────────────────────────────────────────────────────

function startTunnel() {
  if (tunnelProcess) {
    tunnelProcess.removeAllListeners();
    tunnelProcess.kill('SIGTERM');
    tunnelProcess = null;
  }

  writeConfig();

  console.log('[sandbox-tunnel] Starting cloudflared tunnel run...');
  const proc = spawn('cloudflared', [
    'tunnel', '--config', CONFIG_PATH, 'run', '--protocol', 'http2', TUNNEL_ID,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.log(`[sandbox-tunnel] ${text}`);
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.log(`[sandbox-tunnel] ${text}`);
  });

  proc.on('close', (code) => {
    console.log(`[sandbox-tunnel] Process exited with code ${code}`);
    if (tunnelProcess === proc) {
      tunnelProcess = null;
      handleCrash();
    }
  });

  proc.on('error', (err) => {
    console.error(`[sandbox-tunnel] Spawn error: ${err.message}`);
    if (tunnelProcess === proc) {
      tunnelProcess = null;
      handleCrash();
    }
  });

  // Stability timer: if the process runs for 30 minutes without crashing,
  // reset the restart counter so transient blips don't accumulate.
  if (stabilityTimer) clearTimeout(stabilityTimer);
  stabilityTimer = setTimeout(() => {
    stabilityTimer = null;
    if (tunnelProcess === proc && !proc.killed) {
      console.log('[sandbox-tunnel] Tunnel stable for 30 min — resetting restart counter');
      restartCount = 0;
    }
  }, STABILITY_WINDOW_MS);

  tunnelProcess = proc;
  return proc;
}

function handleCrash() {
  if (stopped) return;

  // Clear stability timer — the process crashed
  if (stabilityTimer) {
    clearTimeout(stabilityTimer);
    stabilityTimer = null;
  }

  restartCount++;
  if (restartCount > MAX_RESTART_ATTEMPTS) {
    console.error(`[sandbox-tunnel] Max restart attempts (${MAX_RESTART_ATTEMPTS}) exceeded — giving up`);
    stopped = true;
    return;
  }

  const delay = Math.min(RESTART_COOLDOWN_MS * Math.pow(2, restartCount - 1), MAX_BACKOFF_MS);
  console.log(`[sandbox-tunnel] Auto-restart ${restartCount}/${MAX_RESTART_ATTEMPTS} in ${delay}ms (backoff)...`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startTunnel();
  }, delay);
}

function restartTunnel() {
  // A deliberate restart (config change) resets the crash counter
  restartCount = 0;
  stopped = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  startTunnel();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a port for a sandbox user. Restarts the tunnel with updated config.
 * @param {string} sandboxName — e.g. "Daniel" (will be lowercased)
 * @param {number} port — localhost port number
 */
function registerPort(sandboxName, port) {
  const name = sandboxName.toLowerCase();
  const existing = portMap.get(name);
  portMap.set(name, port);
  console.log(`[sandbox-tunnel] Registered ${name}.${DOMAIN} → localhost:${port}`);

  // Only restart if the mapping actually changed
  if (existing !== port) {
    restartTunnel();
  }
}

/**
 * Remove a sandbox user's port mapping. Restarts the tunnel.
 * @param {string} sandboxName — e.g. "Daniel"
 * @returns {boolean} true if the mapping existed
 */
function unregisterPort(sandboxName) {
  const name = sandboxName.toLowerCase();
  const had = portMap.delete(name);
  if (had) {
    console.log(`[sandbox-tunnel] Unregistered ${name}.${DOMAIN}`);
    restartTunnel();
  }
  return had;
}

/**
 * Get the public URL for a sandbox user.
 * @param {string} sandboxName
 * @returns {string|null} URL like "https://daniel.backtoirl.com" or null
 */
function getTunnelUrl(sandboxName) {
  const name = sandboxName.toLowerCase();
  if (!portMap.has(name)) return null;
  return `https://${name}.${DOMAIN}`;
}

/**
 * Get current tunnel status and all mappings.
 */
function getStatus() {
  const mappings = {};
  for (const [name, port] of portMap) {
    mappings[name] = { port, url: `https://${name}.${DOMAIN}` };
  }
  return {
    running: tunnelProcess !== null && !tunnelProcess.killed,
    stopped,
    restartCount,
    mappings,
  };
}

// ── Auto-start on require ────────────────────────────────────────────────────

// Verify credentials exist before attempting to start
if (fs.existsSync(CREDENTIALS_FILE)) {
  console.log('[sandbox-tunnel] Credentials found — starting tunnel on module load');
  startTunnel();
} else {
  console.warn(`[sandbox-tunnel] Credentials not found at ${CREDENTIALS_FILE} — tunnel disabled`);
  stopped = true;
}

/**
 * Revive a permanently stopped tunnel. Resets state and restarts.
 * Intended for use by the oncall watchdog.
 */
function reviveTunnel() {
  stopped = false;
  restartCount = 0;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  startTunnel();
}

module.exports = { registerPort, unregisterPort, getTunnelUrl, getStatus, reviveTunnel };
