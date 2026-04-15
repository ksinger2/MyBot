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

      // Diagnostic: who is actually linked + what Spotify says is the
      // live top-5 right now. This is how we tell if the wrong account
      // is connected or if Spotify just doesn't know the user's real top.
      let whoami = '';
      let liveTop = '';
      try {
        const token = await ctx.spotifyAuth.getAccessToken(phone);
        if (token) {
          const me = await ctx.spotifyAuth.spotifyApi(token, 'GET', 'me');
          whoami = `\nLinked account: ${me.display_name || me.id} (${me.email || 'no email'})`;
          const top = await ctx.spotifyAuth.spotifyApi(token, 'GET', 'me/top/artists?time_range=short_term&limit=5');
          const names = (top.items || []).map(a => a.name);
          liveTop = names.length ? `\nSpotify says your top 5 (last 4 weeks): ${names.join(', ')}` : '\nSpotify top artists returned empty (!)';
        }
      } catch (e) {
        whoami = `\nwhoami failed: ${e.message.slice(0, 100)}`;
      }

      const fmt = b => `${b.raw}→${b.added}new`;
      const upgradeNote = result.upgraded ? ` [upgraded ${result.upgraded} existing tag${result.upgraded === 1 ? '' : 's'} to Artist category]` : '';
      const lines = [
        `Done. ${after} artists total (+${result.imported} new).${upgradeNote}`,
        `Sources (raw→new): top=${fmt(s.top)}, followed=${fmt(s.followed)}, liked=${fmt(s.liked)}, albums=${fmt(s.albums)}, recent=${fmt(s.recent)}, playlists=${fmt(s.playlists)} (${result.unique} unique).`,
      ];
      if (whoami) lines.push(whoami.trim());
      if (liveTop) lines.push(liveTop.trim());
      if (result.errors.length) {
        lines.push(`⚠️ Partial failures: ${result.errors.join('; ')}`);
      }
      await message.reply(lines.join('\n'));
    } catch (err) {
      await message.reply(`Refresh failed: ${err.message}`);
    }
  },
};
