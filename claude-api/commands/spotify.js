module.exports = {
  name: '!spotify',
  aliases: [],
  adminOnly: false,
  description: 'Connect Spotify account',
  async run(message, arg, state, ctx) {
    try {
      if (!ctx.spotifyAuth) {
        await message.reply('Spotify module not loaded.');
        return;
      }
      if (!process.env.SPOTIFY_CLIENT_ID) {
        await message.reply('Spotify not configured. Set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REDIRECT_URI` env vars.');
        return;
      }
      const authUrl = ctx.spotifyAuth.getAuthUrl(message.author.id);
      try {
        await message.author.send(`Connect your Spotify to the bot:\n${authUrl}\n\nThis lets the bot create collaborative playlists and see your music taste for trip planning.`);
        await message.reply('Sent you a DM with the Spotify authorization link!');
      } catch {
        await message.reply(`I couldn't DM you. Here's the link:\n${authUrl}`);
      }
    } catch (err) {
      await message.reply(`Spotify connect failed: ${err.message.substring(0, 200)}`);
    }
  }
};
