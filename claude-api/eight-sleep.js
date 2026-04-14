/**
 * eight-sleep.js — Per-user Eight Sleep smart mattress integration
 *
 * Direct API client (replaces buggy `eightsleep` npm package).
 * Uses Eight Sleep's V2 API with email/password auth.
 * Per-user credentials encrypted at rest (AES-256-GCM).
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

const TOKENS_FILE = path.join('/app/data', 'eightsleep-tokens.json');
const API_BASE = 'https://client-api.8slp.net/v1';
const AUTH_BASE = 'https://auth-api.8slp.net/v1';
const _clients = new Map(); // userId → { token, expiresAt, userId8s }
const CLIENT_TTL_MS = 30 * 60 * 1000;

// ── Encrypted storage ──

let _encrypt, _decrypt;
try {
  const crypto = require('crypto');
  const KEY = process.env.TOKEN_ENCRYPTION_KEY;
  if (KEY) {
    const DOMAIN = 'mybot-eightsleep';
    const deriveKey = (domain) => crypto.createHmac('sha256', KEY).update(domain).digest();
    _encrypt = (text) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(DOMAIN), iv);
      let enc = cipher.update(text, 'utf8', 'hex');
      enc += cipher.final('hex');
      const tag = cipher.getAuthTag().toString('hex');
      return `${iv.toString('hex')}:${tag}:${enc}`;
    };
    _decrypt = (data) => {
      const [ivHex, tagHex, enc] = data.split(':');
      const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(DOMAIN), Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      let dec = decipher.update(enc, 'hex', 'utf8');
      dec += decipher.final('utf8');
      return dec;
    };
  }
} catch {}

function _readStore() {
  try { if (fs.existsSync(TOKENS_FILE)) return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch {}
  return {};
}
function _writeStore(store) {
  try { atomicWriteJsonSync(TOKENS_FILE, store); } catch (e) { console.error(`[eight-sleep] save failed: ${e.message}`); }
}

function saveCredentials(userId, email, password) {
  const store = _readStore();
  const plain = JSON.stringify({ email, password });
  store[userId] = _encrypt ? _encrypt(plain) : plain;
  _writeStore(store);
  _clients.delete(userId);
}

function _getCredentials(userId) {
  const store = _readStore();
  const entry = store[userId];
  if (!entry) return null;
  try {
    const plain = _decrypt ? _decrypt(entry) : entry;
    return JSON.parse(plain);
  } catch { return null; }
}

function removeCredentials(userId) {
  const store = _readStore();
  delete store[userId];
  _writeStore(store);
  _clients.delete(userId);
}

function hasCredentials(userId) { return !!_getCredentials(userId); }

// ── Direct API client ──

async function _apiRequest(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'MyBot/1.0' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers, signal: AbortSignal.timeout(15000) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) throw new Error(`Eight Sleep API ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function _login(email, password) {
  // Eight Sleep uses OAuth2 password grant at /v1/tokens
  const res = await fetch(`${AUTH_BASE}/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'MyBot/1.0' },
    body: JSON.stringify({
      client_id: process.env.EIGHTSLEEP_CLIENT_ID || '0894c7f33bb94800a03f1f4df13a4f38',
      client_secret: process.env.EIGHTSLEEP_CLIENT_SECRET || 'f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76',
      grant_type: 'password',
      username: email,
      password: password,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Eight Sleep login failed (${res.status}): ${errText.substring(0, 300)}`);
  }
  const data = await res.json();
  return { token: data.access_token, userId8s: data.userId };
}

async function _getAuth(userId) {
  const cached = _clients.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached;
  const creds = _getCredentials(userId);
  if (!creds) return null;
  try {
    const auth = await _login(creds.email, creds.password);
    if (!auth.token) throw new Error('no token in response');
    const entry = { ...auth, expiresAt: Date.now() + CLIENT_TTL_MS };
    _clients.set(userId, entry);
    return entry;
  } catch (e) {
    console.error(`[eight-sleep] Login failed: ${e.message?.substring(0, 100)}`);
    return null;
  }
}

async function getStatus(userId, side = 'left') {
  const auth = await _getAuth(userId);
  if (!auth) return null;
  try {
    const userData = await _apiRequest(`/users/${auth.userId8s}`, { token: auth.token });
    const devices = userData?.user?.devices;
    if (!devices || devices.length === 0) return { error: 'No devices found' };
    const deviceId = devices[0];
    const device = await _apiRequest(`/devices/${deviceId}`, { token: auth.token });
    const d = device?.result || device;

    // Map raw API level (-100 to +100) to app display level (-10 to +10)
    const toAppLevel = (raw) => raw != null ? Math.round(raw / 10) : null;

    const prefix = side === 'right' ? 'right' : 'left';
    const isOn = d[`${prefix}NowHeating`] === true;
    const rawLevel = d[`${prefix}HeatingLevel`];
    const rawTarget = d[`${prefix}TargetHeatingLevel`];
    const heatingDuration = d[`${prefix}HeatingDuration`]; // seconds remaining

    // Get owner names — need to fetch user profiles from the API
    let leftName = null, rightName = null;
    try {
      if (d.leftUserId) {
        const leftUser = await _apiRequest(`/users/${d.leftUserId}`, { token: auth.token });
        leftName = leftUser?.user?.firstName || leftUser?.user?.email || d.leftUserId;
      }
      if (d.rightUserId) {
        const rightUser = await _apiRequest(`/users/${d.rightUserId}`, { token: auth.token });
        rightName = rightUser?.user?.firstName || rightUser?.user?.email || d.rightUserId;
      }
    } catch {} // non-fatal — fall back to IDs

    return {
      on: isOn,
      level: toAppLevel(rawLevel),
      targetLevel: toAppLevel(rawTarget),
      rawLevel,
      durationRemaining: heatingDuration ? Math.round(heatingDuration / 60) : null, // minutes
      leftOwner: leftName,
      rightOwner: rightName,
    };
  } catch (e) {
    console.error(`[eight-sleep] getStatus failed: ${e.message?.substring(0, 200)}`);
    return { error: e.message };
  }
}

async function setTemp(userId, side = 'left', level = 0) {
  const auth = await _getAuth(userId);
  if (!auth) throw new Error('Not authenticated — connect Eight Sleep via !setup');
  const user = await _apiRequest(`/users/${auth.userId8s}`, { token: auth.token });
  const deviceId = user?.user?.devices?.[0];
  if (!deviceId) throw new Error('No device found');
  // User provides app-level (-10 to +10), convert to raw (-100 to +100)
  const appLevel = Math.max(-10, Math.min(10, parseInt(level, 10)));
  const rawLevel = appLevel * 10;
  const prefix = side === 'right' ? 'right' : 'left';
  await _apiRequest(`/devices/${deviceId}`, {
    method: 'PUT',
    token: auth.token,
    body: { [`${prefix}TargetHeatingLevel`]: rawLevel },
  });
  return { side, level: appLevel };
}

async function turnOn(userId, side = 'left') {
  const auth = await _getAuth(userId);
  if (!auth) throw new Error('Not authenticated');
  const user = await _apiRequest(`/users/${auth.userId8s}`, { token: auth.token });
  const deviceId = user?.user?.devices?.[0];
  if (!deviceId) throw new Error('No device found');
  const sideKey = side === 'right' ? 'rightSchedule' : 'leftSchedule';
  await _apiRequest(`/devices/${deviceId}`, {
    method: 'PUT', token: auth.token,
    body: { [sideKey]: { active: true } },
  });
  return { side, on: true };
}

async function turnOff(userId, side = 'left') {
  const auth = await _getAuth(userId);
  if (!auth) throw new Error('Not authenticated');
  const user = await _apiRequest(`/users/${auth.userId8s}`, { token: auth.token });
  const deviceId = user?.user?.devices?.[0];
  if (!deviceId) throw new Error('No device found');
  const sideKey = side === 'right' ? 'rightSchedule' : 'leftSchedule';
  await _apiRequest(`/devices/${deviceId}`, {
    method: 'PUT', token: auth.token,
    body: { [sideKey]: { active: false } },
  });
  return { side, on: false };
}

module.exports = {
  saveCredentials,
  // _getCredentials intentionally NOT exported — prevents credential leakage
  removeCredentials,
  hasCredentials,
  getStatus,
  setTemp,
  turnOn,
  turnOff,
};
