module.exports = {
  name: '!help',
  aliases: [],
  adminOnly: false,
  description: 'Show help text',
  async run(message, arg, state, ctx) {
    // Signal-only bot. Owner (admin) gets the full developer command list;
    // everyone else gets the friendly minimal help.
    let isOwner = false;
    try {
      const { SIGNAL_OWNER } = require('../project-permissions');
      isOwner = SIGNAL_OWNER && message._signalSenderId === SIGNAL_OWNER;
    } catch {}

    if (!isOwner) {
      const helpText =
        `**Hey! Here's what I can do:**\n\n` +
        `Just talk to me naturally — ask me anything, send links, ask for recommendations, plan events, etc.\n\n` +
        `**Useful commands:**\n` +
        `\`!stop\` — Stop my current response\n` +
        `\`!clear\` — Start a fresh conversation\n` +
        `\`!profile\` — See what I know about you\n` +
        `\`!remember <fact>\` — Tell me something to remember\n` +
        `\`!forget <keyword>\` — Remove something I learned\n` +
        `\`!deleteme\` — Delete all your data\n` +
        `\`!personality <name>\` — Switch my vibe\n` +
        `\`!personalities\` — See available vibes\n` +
        `\`!unlock <pin>\` — Unlock code editing (admin)\n\n` +
        `**Concerts:**\n` +
        `\`!concerts [artist]\` — See upcoming shows for your tracked artists\n` +
        `\`!prices <artist>\` — Compare ticket prices across sites\n` +
        `\`!setalert <show> $<price>\` — Get notified when tickets drop\n` +
        `\`!alerts\` — View your price alerts\n` +
        `\`!removealert <# or name>\` — Cancel a price alert\n` +
        `\`!track\` — View/edit your tracked artist list\n\n` +
        `**Shopping:**\n` +
        `\`!product <query>\` — Find product links & compare prices\n\n` +
        `**Pro tip:** You don't need commands for most things. Just ask!\n` +
        `"draw me a sunset" • "summarize this TikTok" • "when can we all hang out?" • "remind me tomorrow at 3pm" • "find me earbuds under $50"`;
      await message.reply(helpText);
      return;
    }

    // Owner — full developer command list
    const helpText =
      `**Claude Code Bot — Commands:**\n\n` +
      `**Control:**\n` +
      `\`!stop\` — Pause Claude (session preserved)\n` +
      `\`!clear\` — Clear conversation context\n` +
      `\`!kill\` — Hard kill + destroy session\n` +
      `\`!killall\` — Kill everything across all channels\n` +
      `\`!restart\` — Restart bot container\n` +
      `\`!refresh\` — Nuclear reset\n` +
      `\`!status\` — Show session info\n` +
      `\`!processes\` — Show active Claude processes\n` +
      `\`!btw\` — Peek at progress while working\n\n` +
      `**Workspace:**\n` +
      `\`!cd [path]\` — Show or change project\n` +
      `\`!ls [path]\` — List files\n` +
      `\`!startproject\` — Create project from template\n\n` +
      `**Identity:**\n` +
      `\`!personality <name>\` — Switch personality\n` +
      `\`!personalities\` — List available\n\n` +
      `**Autonomy:** \`!loop <task>\` · \`!heartbeat <min>\` · \`!orders\`\n` +
      `**Schedule:** \`!schedule\` · \`!schedules\` · \`!unschedule <#>\` · \`!autoschedule\`\n` +
      `**Monitors:** \`!monitor ci|health\` · \`!monitors\`\n` +
      `**Services:** \`!services\` · \`!service stop|logs <name>\`\n` +
      `**Config:** \`!config show|turns|continues|timeout <N>\`\n` +
      `**Security:** \`!unlock <pin>\` · \`!permit\` · \`!revoke\` · \`!perms\`\n` +
      `**Profile:** \`!profile\` · \`!remember\` · \`!forget\` · \`!deleteme\`\n` +
      `**Concerts:** \`!concerts\` · \`!prices\` · \`!setalert\` · \`!alerts\` · \`!removealert\` · \`!track\` · \`!concerttracker\`\n` +
      `**Shopping:** \`!product\` / \`!search\` — find & compare products\n\n` +
      `Just type what you want built. Use \`!stop\` to interrupt.\n\n` +
      `Current: **${state.identity?.name || 'Bot'}** | ${state.personality || 'default'} | \`${state.cwd}\` | ${state.busy ? '🔄 WORKING' : (state.sessionId ? '💤 idle' : '⚫ no session')}`;
    await ctx.sendLongMessage(message, helpText, state.cwd);
  }
};
