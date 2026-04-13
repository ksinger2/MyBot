/**
 * setalert.js — !setalert [artist/show] $[price]
 *
 * Creates a dm-task schedule that checks ticket prices 4x daily and DMs
 * the user when the lowest price drops to or below their threshold.
 *
 * Usage: !setalert Chappell Roan $75
 *        !setalert Jack Johnson Greek Theatre $50
 */

module.exports = {
  name: '!setalert',
  aliases: [],
  adminOnly: false,
  description: 'Set a price alert for a concert — get DMed when tickets drop below your target',
  async run(message, arg, state, ctx) {
    const isGroup = message._signalChatId && message._signalChatId !== message._signalSenderId;
    if (isGroup) {
      await message.reply('Price alerts are personal — DM me to set one up.');
      return;
    }

    if (!arg) {
      await message.reply(
        'Usage: `!setalert <show name> $<price>`\n' +
        'Examples:\n' +
        '  `!setalert Chappell Roan $75`\n' +
        '  `!setalert Jack Johnson Greek Theatre June 14 $50`\n\n' +
        "I'll check prices 4x daily (8am, noon, 4pm, 8pm PT) and DM you when they drop to your target."
      );
      return;
    }

    // Parse: everything before the last $XX is the show name, $XX is the threshold
    const priceMatch = arg.match(/^(.+?)\s+\$(\d+(?:\.\d+)?)\s*$/);
    if (!priceMatch) {
      await message.reply(
        'Could not parse your alert. Make sure to include a price like `$75` at the end.\n' +
        'Example: `!setalert Chappell Roan $75`'
      );
      return;
    }

    const showName = priceMatch[1].trim();
    const threshold = parseFloat(priceMatch[2]);

    if (!showName) {
      await message.reply('Please include the artist or show name before the price.');
      return;
    }

    if (isNaN(threshold) || threshold <= 0) {
      await message.reply('Please provide a valid price threshold, e.g. `$75`.');
      return;
    }

    // Build the Claude prompt for the scheduled dm-task
    const jobPrompt = `Check ticket prices for "${showName}" using the concert scraper at POST http://localhost:3400/concerts/prices with body {"artist":"${showName}","city":"Alameda"} and header X-Internal-Token: $INTERNAL_API_TOKEN.

Parse the JSON response and find the lowest price from any source (stubhub, vividseats, tickpick, seatgeek, ticketmaster). If the response says the scraper is not running, do nothing (empty response).

If the lowest price found is at or below $${threshold}, reply with:
"🎟️ Price alert: ${showName} tickets are now $[LOWEST_PRICE] at [SOURCE]! [URL if available]"

Otherwise reply with nothing (empty response — do not send any message).`;

    // Default: 8am, noon, 4pm, 8pm PT
    const cronRule = '0 8,12,16,20 * * *';
    const description = `Price Alert: ${showName} (below $${threshold})`;

    const sched = ctx.addSchedule({
      userId: message.author.id,
      channelId: message.channel.id,
      message: jobPrompt,
      cronRule,
      description,
      type: 'task',
      timezone: 'America/Los_Angeles',
    });

    ctx.registerJob(sched, ctx.client);

    await message.reply(
      `Alert set! **#${sched.id}**\n` +
      `I'll check prices for **${showName}** 4x daily (8am, noon, 4pm, 8pm PT) and DM you when they drop to **$${threshold}** or below.\n\n` +
      `Use \`!alerts\` to see all your price alerts, or \`!removealert ${sched.id}\` to cancel.`
    );
  },
};
