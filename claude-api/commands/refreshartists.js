module.exports = {
  name: '!refreshartists',
  aliases: ['!refreshspotify', '!repullartists', '!reimportartists'],
  adminOnly: false,
  description: 'Re-import your Spotify artists (top + followed + liked + saved albums)',
  async run(message, arg, state, ctx) {
    const phone = message._signalSenderId || message.author?.id;
    if (!phone) {
      await message.reply('This command only works on Signal.');
      return;
    }
    if (!ctx.spotifyAuth) {
      await message.reply('Spotify module not loaded.');
      return;
    }

    const { getProfile } = require('../user-profiles');
    const profile = getProfile(phone);
    if (!profile?.spotify_connected) {
      await message.reply('Spotify not connected — run `!setup` first and link your account.');
      return;
    }

    const before = (profile.tags || []).filter(t => t.category === 'Artist').length;
    await message.reply(`Refreshing artists from Spotify (you have ${before} now)…`);

    try {
      const result = await ctx.spotifyAuth.importUserArtists(phone);
      const after = (getProfile(phone)?.tags || []).filter(t => t.category === 'Artist').length;
      const s = result.sources;
      const lines = [
        `Done. ${after} artists total (+${result.imported} new).`,
        `Sources: top=${s.top}, followed=${s.followed}, liked=${s.liked}, albums=${s.albums}, recent=${s.recent}, playlists=${s.playlists} (${result.unique} unique).`,
      ];
      if (result.errors.length) {
        lines.push(`⚠️ Partial failures: ${result.errors.join('; ')}`);
      }
      await message.reply(lines.join('\n'));
    } catch (err) {
      await message.reply(`Refresh failed: ${err.message}`);
    }
  },
};
