/**
 * track.js — !track [list|add|remove|clear] [...]
 *
 * Quick editor for `profile.concert_tracker_artists`, the curated
 * list that `!concerts` and the concert-tracker scheduled job use.
 *
 * Usage:
 *   !track                           — show the current tracked list
 *   !track list                      — same as above
 *   !track add Beyoncé               — add one artist
 *   !track add Beyoncé, The Weeknd   — add multiple (comma-separated)
 *   !track remove 5                  — remove by list number
 *   !track remove 5, 7, 12           — remove multiple numbers
 *   !track remove Beyoncé            — remove by name (case-insensitive)
 *   !track clear                     — wipe the whole curated list
 *
 * For a bigger re-curate (location, frequency, price alerts), use
 * `!concerttracker` which runs the full wizard.
 */

const { getProfile, setProfile } = require('../user-profiles');

function _formatList(artists) {
  if (!artists || artists.length === 0) return '_(empty)_';
  return artists.map((a, i) => `${i + 1}. ${a}`).join('\n');
}

function _chunkReply(text, reply) {
  if (text.length <= 1900) return reply(text);
  let remaining = text;
  const sends = [];
  while (remaining.length > 0) {
    const cut = remaining.lastIndexOf('\n', 1900);
    const end = cut > 0 ? cut : 1900;
    sends.push(reply(remaining.slice(0, end)));
    remaining = remaining.slice(end).trimStart();
  }
  return Promise.all(sends);
}

module.exports = {
  name: '!track',
  aliases: ['!tracked'],
  adminOnly: false,
  description: 'View or edit your concert-tracker artist list',
  async run(message, arg, state, ctx) {
    const phone = message._signalSenderId || message.author?.id || null;
    if (!phone) {
      await message.reply('This command only works for Signal/DM users with a profile.');
      return;
    }

    const profile = getProfile(phone) || {};
    const current = Array.isArray(profile.concert_tracker_artists)
      ? [...profile.concert_tracker_artists]
      : [];

    const input = (arg || '').trim();
    const [verbRaw, ...restTokens] = input.split(/\s+/);
    const verb = (verbRaw || '').toLowerCase();
    const rest = input.replace(/^\w+\s*/, '').trim();

    // ── Default + explicit "list" — show the current list ───────────
    if (!verb || verb === 'list' || verb === 'show' || verb === 'ls') {
      if (current.length === 0) {
        await message.reply([
          'Your tracked artist list is empty.',
          '',
          'Add some: `!track add Taylor Swift, Beyoncé`',
          'Or run the full wizard: `!concerttracker`',
          'Or connect Spotify: `!setup` → pull your top artists automatically',
        ].join('\n'));
        return;
      }
      await _chunkReply(
        [
          `🎵 **Your tracked artists** (${current.length})`,
          '',
          _formatList(current),
          '',
          'Edit with `!track add <name>`, `!track remove <number or name>`, or `!track clear`.',
          'Run `!concerts` to search for upcoming shows across this list.',
        ].join('\n'),
        (t) => message.reply(t),
      );
      return;
    }

    // ── clear ───────────────────────────────────────────────────────
    if (verb === 'clear' || verb === 'wipe' || verb === 'reset') {
      if (current.length === 0) {
        await message.reply('Your tracked list is already empty.');
        return;
      }
      setProfile(phone, { concert_tracker_artists: [] });
      await message.reply(`Cleared all ${current.length} tracked artists. Add new ones with \`!track add <name>\` or run \`!concerttracker\` to rebuild.`);
      return;
    }

    // ── add ─────────────────────────────────────────────────────────
    if (verb === 'add' || verb === 'a' || verb === '+') {
      if (!rest) {
        await message.reply('What should I add? Example: `!track add Taylor Swift` or `!track add Beyoncé, The Weeknd`');
        return;
      }
      const newNames = rest.split(/,|\n/).map(s => s.trim()).filter(Boolean);
      if (newNames.length === 0) {
        await message.reply('Give me at least one artist name.');
        return;
      }
      // Dedup against current list (case-insensitive)
      const existingLower = new Set(current.map(a => a.toLowerCase()));
      const toAdd = newNames.filter(n => !existingLower.has(n.toLowerCase()));
      const skipped = newNames.filter(n => existingLower.has(n.toLowerCase()));
      const next = [...current, ...toAdd];
      setProfile(phone, { concert_tracker_artists: next });
      const parts = [
        `Added ${toAdd.length} artist${toAdd.length === 1 ? '' : 's'}: ${toAdd.join(', ')}`,
      ];
      if (skipped.length > 0) parts.push(`Already tracked (skipped): ${skipped.join(', ')}`);
      parts.push(`Now tracking ${next.length} total. \`!track list\` to see the full list.`);
      await message.reply(parts.join('\n'));
      return;
    }

    // ── remove ──────────────────────────────────────────────────────
    if (verb === 'remove' || verb === 'rm' || verb === 'delete' || verb === 'del' || verb === '-') {
      if (!rest) {
        await message.reply('What should I remove? Example: `!track remove 5`, `!track remove 5, 7, 12`, or `!track remove Beyoncé`');
        return;
      }
      if (current.length === 0) {
        await message.reply('Your tracked list is already empty.');
        return;
      }

      // Try number-based removal first (including comma / space lists)
      const nums = rest.split(/[,\s]+/).map(s => parseInt(s.replace('#', ''), 10)).filter(n => !isNaN(n));
      let removed = [];
      let next = current;

      if (nums.length > 0 && nums.every(n => n >= 1 && n <= current.length)) {
        // Number-based
        const idxSet = new Set(nums.map(n => n - 1));
        removed = current.filter((_, i) => idxSet.has(i));
        next = current.filter((_, i) => !idxSet.has(i));
      } else {
        // Name-based (case-insensitive, supports comma list)
        const targets = rest.split(/,|\n/).map(s => s.trim().toLowerCase()).filter(Boolean);
        if (targets.length === 0) {
          await message.reply('Give me a number, comma-separated numbers, or artist name(s) to remove.');
          return;
        }
        removed = current.filter(a => targets.includes(a.toLowerCase()));
        next = current.filter(a => !targets.includes(a.toLowerCase()));
        if (removed.length === 0) {
          await message.reply(`No matches found for "${rest}". Use \`!track list\` to see the numbered list, then \`!track remove <number>\`.`);
          return;
        }
      }

      setProfile(phone, { concert_tracker_artists: next });
      await message.reply([
        `Removed ${removed.length} artist${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}`,
        `Now tracking ${next.length} total. \`!track list\` to see the full list.`,
      ].join('\n'));
      return;
    }

    // ── unknown verb — show usage ──────────────────────────────────
    await message.reply([
      'Usage:',
      '  `!track` — show your tracked artists',
      '  `!track add <name>` — add (comma-separate for multiple)',
      '  `!track remove <# or name>` — remove by number or name',
      '  `!track clear` — wipe the list',
      '',
      'For the full setup (location, frequency, price alerts), run `!concerttracker`.',
    ].join('\n'));
  },
};
