/**
 * data-recovery.js — Startup reconciliation for the UUID↔phone map.
 *
 * Talks to the signal-cli-rest-api sidecar (bbernhard/signal-cli-rest-api) and
 * pulls every UUID↔phone pair it can find — contacts, group members, identities
 * — so that if /app/data/signal-uuid-phone.json was ever lost (fresh volume,
 * accidental delete, corruption) we can rebuild the cache without requiring
 * each user to send a fresh message first.
 *
 * Contract:
 *   runDataRecovery(uuidMap, signalApiUrl, phoneNumber) → { added, total }
 *
 * Where uuidMap is the shared v2 structure owned by SignalAdapter:
 *   { version: 2,
 *     byUuid: { "<uuid>": { phone, firstSeen, lastSeen } },
 *     byPhone: { "<phone>": ["<uuid>", ...] } }
 *
 * Rules:
 * - Never throws. Every network call is try/caught; warnings go to console.
 * - Mutates the passed uuidMap in place. Caller is responsible for persisting.
 * - Never migrates tokens or profiles. If a phone already has UUIDs and a new
 *   one turns up from the sidecar, the new UUID is ADDED to byPhone[phone] —
 *   nothing else is touched. Token migration is an owner-only operation.
 */

const http = require('http');
const { URL } = require('url');

function _get(rawUrl, timeoutMs = 15000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(rawUrl);
      const req = http.get({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        timeout: timeoutMs,
        headers: { 'Accept': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            return resolve({ ok: false, status: res.statusCode, body: null });
          }
          try { resolve({ ok: true, status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ ok: false, status: res.statusCode, body: null }); }
        });
      });
      req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} });
      req.on('error', () => resolve({ ok: false, status: 0, body: null }));
    } catch {
      resolve({ ok: false, status: 0, body: null });
    }
  });
}

function _record(uuidMap, uuid, phone) {
  if (!uuid || typeof uuid !== 'string') return false;
  if (!phone || typeof phone !== 'string' || !phone.startsWith('+')) return false;
  const now = Date.now();
  let added = false;
  if (!uuidMap.byUuid[uuid]) {
    uuidMap.byUuid[uuid] = { phone, firstSeen: now, lastSeen: now };
    added = true;
  } else {
    uuidMap.byUuid[uuid].lastSeen = now;
    if (uuidMap.byUuid[uuid].phone !== phone) uuidMap.byUuid[uuid].phone = phone;
  }
  if (!uuidMap.byPhone[phone]) uuidMap.byPhone[phone] = [];
  if (!uuidMap.byPhone[phone].includes(uuid)) uuidMap.byPhone[phone].push(uuid);
  return added;
}

async function _recoverFromContacts(uuidMap, base, phoneNumber) {
  let added = 0;
  try {
    const url = `${base}/v1/contacts/${encodeURIComponent(phoneNumber)}`;
    const resp = await _get(url);
    if (!resp.ok || !Array.isArray(resp.body)) {
      console.warn(`[data-recovery] contacts: HTTP ${resp.status || 'n/a'} — skipping`);
      return 0;
    }
    for (const c of resp.body) {
      if (!c) continue;
      if (c.uuid && c.number) {
        if (_record(uuidMap, c.uuid, c.number)) added++;
      }
    }
  } catch (err) {
    console.warn(`[data-recovery] contacts failed: ${err.message}`);
  }
  return added;
}

async function _recoverFromGroups(uuidMap, base, phoneNumber) {
  let added = 0;
  try {
    const url = `${base}/v1/groups/${encodeURIComponent(phoneNumber)}`;
    const resp = await _get(url);
    if (!resp.ok || !Array.isArray(resp.body)) {
      console.warn(`[data-recovery] groups: HTTP ${resp.status || 'n/a'} — skipping`);
      return 0;
    }
    for (const g of resp.body) {
      if (!g) continue;
      // bbernhard group objects have `members`, `pending_invites`, `admins`
      // as arrays of phone numbers. Some versions include UUID-tagged members
      // under `members_uuids` or similar — try every known shape defensively.
      const candidateLists = [g.members, g.pending_invites, g.admins, g.members_uuids, g.pending_members]
        .filter(Array.isArray);
      for (const list of candidateLists) {
        for (const member of list) {
          if (!member) continue;
          // Might be a plain string (phone or uuid) or an object {uuid, number}
          if (typeof member === 'string') continue; // no pair info here
          if (typeof member === 'object') {
            const uuid = member.uuid || member.serviceId || member.aci;
            const number = member.number || member.phone || member.e164;
            if (uuid && number) {
              if (_record(uuidMap, uuid, number)) added++;
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[data-recovery] groups failed: ${err.message}`);
  }
  return added;
}

async function _recoverFromIdentities(uuidMap, base, phoneNumber) {
  let added = 0;
  try {
    const url = `${base}/v1/identities/${encodeURIComponent(phoneNumber)}`;
    const resp = await _get(url);
    if (!resp.ok || !Array.isArray(resp.body)) {
      console.warn(`[data-recovery] identities: HTTP ${resp.status || 'n/a'} — skipping`);
      return 0;
    }
    for (const id of resp.body) {
      if (!id) continue;
      const uuid = id.uuid || id.serviceId || id.aci;
      const number = id.number || id.phone;
      if (uuid && number) {
        if (_record(uuidMap, uuid, number)) added++;
      }
    }
  } catch (err) {
    console.warn(`[data-recovery] identities failed: ${err.message}`);
  }
  return added;
}

/**
 * Rebuild the UUID↔phone mapping from the signal-cli-rest-api sidecar.
 * @param {object} uuidMap - Shared v2 UUID map (mutated in place)
 * @param {string} signalApiUrl - Base URL of the sidecar (no trailing slash)
 * @param {string} phoneNumber - Bot's registered E.164 number
 * @returns {Promise<{added: number, total: number}>}
 */
async function runDataRecovery(uuidMap, signalApiUrl, phoneNumber) {
  if (!uuidMap || typeof uuidMap !== 'object') {
    console.warn('[data-recovery] uuidMap missing — aborting');
    return { added: 0, total: 0 };
  }
  if (!signalApiUrl || !phoneNumber) {
    console.warn('[data-recovery] signalApiUrl or phoneNumber missing — aborting');
    return { added: 0, total: Object.keys(uuidMap.byUuid || {}).length };
  }
  const base = signalApiUrl.replace(/\/$/, '');
  let added = 0;
  try {
    added += await _recoverFromContacts(uuidMap, base, phoneNumber);
    added += await _recoverFromGroups(uuidMap, base, phoneNumber);
    added += await _recoverFromIdentities(uuidMap, base, phoneNumber);
  } catch (err) {
    // Defensive — individual helpers already catch their own errors, but in
    // case anything slips through, keep the promise non-rejecting.
    console.warn(`[data-recovery] unexpected error: ${err.message}`);
  }
  const total = Object.keys(uuidMap.byUuid || {}).length;
  console.log(`[data-recovery] Added ${added} new UUID→phone mappings from sidecar (total known: ${total})`);
  return { added, total };
}

module.exports = { runDataRecovery };
