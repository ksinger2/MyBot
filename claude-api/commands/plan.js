module.exports = {
  name: '!plan',
  aliases: [],
  adminOnly: false,
  description: 'Plan around a link, event, or destination',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply('Usage: `!plan <link or description>` — paste a TikTok, Instagram, Maps, Yelp, or Eventbrite link, or describe a place/event.');
      return;
    }
    if (state.busy) {
      await message.reply('Already working. Use `!stop` first.');
      return;
    }
    const { detectLinks, buildSmartPrompt, enrichLinks } = require('../link-extractor');
    const links = detectLinks(arg);
    let planPrompt;
    if (links.length > 0) {
      const enriched = await enrichLinks(links);
      planPrompt = buildSmartPrompt(enriched) + arg;
    } else {
      planPrompt = `[PLANNING MODE]\nThe user wants to plan around this:\n${arg}\n\nUse WebSearch to research this destination/event. Provide: what it is, address, pet-friendly status, things to do nearby, distance from Alameda CA (drive/fly), weather, budget estimate. Check the user's calendar for good times to visit. Keep output Discord-concise.`;
    }

    state.busy = true;
    state.startedAt = Date.now();
    state.progress = ctx.freshProgress();
    await ctx._styping(message);
    const planTyping = setInterval(() => { ctx._styping(message).catch(() => {}); }, 8000);

    try {
      const personalityFile = ctx.getPersonalityFile(state.personality);
      const result = await ctx.askClaude(planPrompt, {
        sessionId: state.sessionId,
        personalityFile,
        identity: state.identity,
        cwd: state.cwd,
        maxTurns: 20,
        channelState: state,
      });
      if (result.sessionId) state.sessionId = result.sessionId;
      if (!result.stopped) await ctx.sendLongMessage(message, result.text, state.cwd);
    } catch (err) {
      await message.reply(`Plan failed: ${err.message.substring(0, 300)}`).catch(() => {});
      ctx.sendErrorAlert(err, { source: 'plan command', channel: message.channel.id });
    } finally {
      clearInterval(planTyping);
      state.busy = false;
      state.startedAt = null;
      state.progress = ctx.freshProgress();
    }
  }
};
