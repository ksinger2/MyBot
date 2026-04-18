/**
 * !recover-data — Owner command to rebuild the UUID→phone mapping from
 * the signal-cli-rest-api sidecar on demand.
 *
 * Useful after a volume wipe, a bad migration, or anytime the on-disk
 * signal-uuid-phone.json has fallen out of sync with what the sidecar knows.
 * Never touches tokens or profiles — that is a separate (P1-B) workflow.
 */

const fs = require('fs');

function _countEntries(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return 0;
    return Object.keys(raw).length;
  } catch {
    return 0;
  }
}

module.exports = {
  name: '!recover-data',
  aliases: ['!recoverdata'],
  adminOnly: true,
  description: 'Rebuild UUID→phone mapping from the Signal sidecar (owner only)',
  async run(message, arg, state, ctx) {
    let signalAdapter = null;
    try {
      signalAdapter = require('../bot').signalAdapter;
    } catch {}

    if (!signalAdapter) {
      await message.reply('Signal adapter is not running — nothing to recover.');
      return;
    }

    const apiUrl = process.env.SIGNAL_API_URL || 'http://signal-api:8080';
    const phone = signalAdapter.phoneNumber;
    if (!phone) {
      await message.reply('SIGNAL_PHONE_NUMBER not configured — cannot query sidecar.');
      return;
    }

    await message.reply('Running data recovery from Signal sidecar...');

    let result;
    try {
      const { runDataRecovery } = require('../data-recovery');
      const uuidMap = signalAdapter.getUuidMap();
      result = await runDataRecovery(uuidMap, apiUrl, phone);
      if (result && result.added > 0) {
        signalAdapter.persistUuidMap();
      }
    } catch (err) {
      await message.reply(`Data recovery hit an error: ${err.message}`);
      return;
    }

    const profileCount = _countEntries('/app/data/user-profiles.json');
    const tokenCount = _countEntries('/app/data/user-tokens.json');

    const lines = [
      `Data recovery complete. Added ${result.added} new UUID→phone mappings. Total: ${result.total} known.`,
      `Profiles in user-profiles.json: ${profileCount}`,
      `Users in user-tokens.json: ${tokenCount}`,
    ];
    await message.reply(lines.join('\n'));
  },
};
