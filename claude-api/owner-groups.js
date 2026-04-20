/**
 * owner-groups.js — tracks group chats that get full owner-mode CLI access.
 *
 * Registered via `!ownergroup add` in any group chat. Owner groups bypass the
 * SDK fast-path, get ownerDmMode (Opus, no turn limit, no brevity), and don't
 * require @mentions.
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('./atomic-write');

const DATA_PATH = path.join('/app/data', 'owner-groups.json');

function _load() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function _save(set) {
  atomicWriteJsonSync(DATA_PATH, [...set]);
}

function isOwnerGroup(chatId) {
  return _load().has(chatId);
}

function addOwnerGroup(chatId) {
  const set = _load();
  set.add(chatId);
  _save(set);
}

function removeOwnerGroup(chatId) {
  const set = _load();
  set.delete(chatId);
  _save(set);
}

function listOwnerGroups() {
  return [..._load()];
}

module.exports = { isOwnerGroup, addOwnerGroup, removeOwnerGroup, listOwnerGroups };
