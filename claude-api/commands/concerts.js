/**
 * concerts.js — !concerts [artist]
 *
 * With an arg: search for that specific artist's upcoming shows.
 * Without an arg: fan-out search across ALL of the user's tracked
 * artists (curated `concert_tracker_artists` if set, else every
 * `category: 'Artist'` tag in the profile).
 *
 * All show-listing logic lives in plugins/concert-tracker/find-shows.js
 * — this file is the display layer only. The same module is called
 * deterministically by the scheduler for cron-fired concert tracker
 * jobs.
 */

const { getProfile } = require('../user-profiles');
const {
  findUpcomingShows,
  searchTicketmaster,
  resolveLocation,
  deriveCity,
  formatEvent,
  DEFAULT_RADIUS_MILES,
  MAX_UNCURATED_FANOUT,
} = require('../plugins/concert-tracker/find-shows');

const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY || '';

async function _chunkReply(text, reply) {
  if (text.length <= 1900) return reply(text);
  let remaining = text;
  while (remaining.length > 0) {
    const cut = remaining.lastIndexOf('\n', 1900);
    const end = cut > 0 ? cut : 1900;
    await reply(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
}

module.exports = {
  name: '!concerts',
  aliases: ['!shows'],
  adminOnly: false,
  description: 'List upcoming concerts for your favorite artists (or one specific artist)',
  async run(message, arg, state, ctx) {
    const specificArtist = (arg || '').trim();
    const phone = message._signalSenderId || message.author?.id || null;
    const profile = phone ? (getProfile(phone) || {}) : {};
    const location = profile.location || 'Alameda California';
    const city = deriveCity(location) || 'Alameda';

    // ── Single-artist path ─────────────────────────────────────────
    if (specificArtist) {
      if (!TICKETMASTER_API_KEY) {
        const tmUrl = `https://www.ticketmaster.com/search?q=${encodeURIComponent(specificArtist)}`;
        await message.reply([
          `🎵 **${specificArtist}** — Ticketmaster search`,
          `${tmUrl}`,
          '',
          `Use \`!prices ${specificArtist}\` to compare prices across StubHub, VividSeats, TickPick, SeatGeek.`,
          '',
          `_(Structured concert data unavailable — \`TICKETMASTER_API_KEY\` not set.)_`,
        ].join('\n'));
        return;
      }
      await message.reply(`Searching ${specificArtist} shows near ${city}…`);
      const coords = await resolveLocation(location);
      let events = await searchTicketmaster(specificArtist, coords, city);
      if ((!events || events.length === 0) && !coords) {
        events = await searchTicketmaster(specificArtist, null, 'San Francisco');
      }
      if (!events || events.length === 0) {
        await message.reply(`No upcoming ${specificArtist} shows found near ${city}. Try \`!prices ${specificArtist}\` for secondary-market listings.`);
        return;
      }
      const formatted = events.slice(0, 8).map(e => formatEvent(e, specificArtist));
      const lines = [`**${specificArtist} — upcoming shows near ${city}**`, ''];
      for (const e of formatted) {
        lines.push(`• ${e.date}${e.time} — ${e.venueName}${e.loc ? ` (${e.loc})` : ''}`);
      }
      lines.push('');
      lines.push(`Use \`!prices ${specificArtist}\` to compare ticket prices across sites.`);
      await message.reply(lines.join('\n'));
      return;
    }

    // ── Fan-out path: all tracked artists ──────────────────────────
    const curated = Array.isArray(profile.concert_tracker_artists) ? profile.concert_tracker_artists : null;
    const fromTags = (profile.tags || []).filter(t => t.category === 'Artist').map(t => t.label);
    const usingCurated = !!(curated && curated.length > 0);
    const source = usingCurated ? curated : fromTags;
    if (source.length === 0) {
      await message.reply('I don\'t have any tracked artists for you yet. Connect Spotify via `!setup` or run `!concerttracker` to pick artists manually.');
      return;
    }

    if (!TICKETMASTER_API_KEY) {
      const topN = source.slice(0, 15);
      const lines = [
        `🎵 **Concert search** — ${topN.length} of your tracked artists`,
        `📍 Near ${city} (browse each artist's Ticketmaster page)`,
        '',
      ];
      for (const a of topN) {
        lines.push(`• **${a}**: https://www.ticketmaster.com/search?q=${encodeURIComponent(a)}`);
      }
      lines.push('');
      lines.push(`_(For structured data: get a free key at developer.ticketmaster.com and set \`TICKETMASTER_API_KEY\` in \`.env\`.)_`);
      await _chunkReply(lines.join('\n'), (t) => message.reply(t));
      return;
    }

    // Curated lists are respected in full (the user explicitly picked
    // them). Uncurated raw Spotify tags get capped to MAX_UNCURATED_FANOUT.
    const cap = !usingCurated;
    const capNote = (!usingCurated && source.length > MAX_UNCURATED_FANOUT)
      ? ` (top ${MAX_UNCURATED_FANOUT} of ${source.length} — run \`!concerttracker\` to curate)`
      : (usingCurated ? ' (curated list)' : '');

    await message.reply(`Searching upcoming shows for ${Math.min(source.length, cap ? MAX_UNCURATED_FANOUT : source.length)} artists near ${city}${capNote}…`);

    const result = await findUpcomingShows({
      artists: source,
      location,
      cap,
    });

    if (!result.ok) {
      await message.reply(`Couldn't search shows: ${result.reason}.`);
      return;
    }

    if (result.shows.length === 0) {
      await message.reply(`Searched all ${result.searchedArtists.length} of your tracked artists — none have upcoming shows within ${result.radiusMiles} miles of ${city} in the next ${result.lookAheadMonths} months. They may be touring elsewhere — try \`!concerts <artist>\` with a specific name to search nationwide.`);
      return;
    }

    const header = [
      `🎵 **Upcoming shows near ${city}** — searched ${result.searchedArtists.length} of your tracked artists${capNote}`,
      `✅ ${result.withShowsCount} with shows · 💤 ${result.noShowArtists.length} with nothing within ${result.radiusMiles} miles · ${result.shows.length} total events`,
      '',
    ];
    const body = [];
    for (const [artist, shows] of result.byArtist) {
      body.push(`**${artist}**`);
      for (const s of shows.slice(0, 5)) {
        body.push(`  • ${s.date}${s.time} — ${s.venueName}${s.loc ? ` (${s.loc})` : ''}`);
      }
    }
    const footer = [
      '',
      'Use `!prices <artist>` to compare ticket prices, or `!setalert <show> $<price>` to watch a show.',
    ];
    let noShowTail = [];
    if (result.noShowArtists.length > 0) {
      noShowTail = ['', `_No current shows: ${result.noShowArtists.join(', ')}_`];
    }

    const allLines = [...header, ...body, ...footer, ...noShowTail];

    // Single-message fast path
    const fullLen = allLines.reduce((n, l) => n + l.length + 1, 0);
    if (fullLen <= 1900) {
      await message.reply(allLines.join('\n'));
      return;
    }

    // Multi-message: header, then artist blocks, then footer
    const HEADER_BLOCK = header.join('\n');
    const FOOTER_BLOCK = [...footer, ...noShowTail].join('\n');
    await message.reply(HEADER_BLOCK);

    const artistBlocks = [];
    let currentBlock = [];
    for (const line of body) {
      if (line.startsWith('**') && currentBlock.length > 0) {
        artistBlocks.push(currentBlock.join('\n'));
        currentBlock = [line];
      } else {
        currentBlock.push(line);
      }
    }
    if (currentBlock.length > 0) artistBlocks.push(currentBlock.join('\n'));

    let buffer = '';
    for (const block of artistBlocks) {
      if (buffer && (buffer.length + block.length + 2) > 1800) {
        await message.reply(buffer);
        buffer = block;
      } else {
        buffer = buffer ? buffer + '\n\n' + block : block;
      }
    }
    if (buffer) await message.reply(buffer);
    await message.reply(FOOTER_BLOCK.trim());
  },
};
