module.exports = {
  name: '!help',
  aliases: [],
  adminOnly: false,
  description: 'Show help text with all commands',
  async run(message, arg, state, ctx) {
    const helpText =
      `**Claude Code Bot — Commands:**\n\n` +
      `**Control:**\n` +
      `\`!stop\` — Pause Claude (session preserved)\n` +
      `\`!clear\` — Clear conversation context\n` +
      `\`!kill\` — Hard kill + destroy session\n` +
      `\`!killall\` — Kill everything across all channels\n` +
      `\`!restart\` — Restart bot container\n` +
      `\`!refresh\` — Nuclear reset: kill all, clear state, restart\n` +
      `\`!status\` — Show session info\n` +
      `\`!processes\` — Show active Claude processes\n` +
      `\`!btw\` — Peek at progress while working\n` +
      `\`!cancel\` — Cancel an active wizard\n\n` +
      `**Workspace:**\n` +
      `\`!cd [path]\` — Show or change project directory\n` +
      `\`!ls [path]\` — List files\n` +
      `\`!startproject\` — Create a new project with template\n` +
      `\`!audit [focus]\` — Full project audit (design, qa, security, analytics, performance)\n\n` +
      `**Identity:**\n` +
      `\`!name [name]\` — Show or set bot name\n` +
      `\`!identity [Name is desc]\` — Show or set identity\n` +
      `\`!personality <name>\` — Switch personality\n` +
      `\`!personalities\` — List available\n\n` +
      `**Tasks:** \`!tasks\` · \`!done\` · \`!done all\`\n` +
      `**Schedule:** \`!schedule\` · \`!schedules\` · \`!unschedule <#>\` · \`!autoschedule <freq> | <task>\`\n` +
      `**Queue:** \`!queue <task>\` · \`!queued\` · \`!dequeue <#>\`\n` +
      `**Monitors:** \`!monitor ci <repo>\` · \`!monitor health <url>\` · \`!monitors\` · \`!monitor remove/pause/resume/check <#>\`\n` +
      `**Briefing:** \`!briefing\` · \`!weekly\`\n` +
      `**Preview:** \`!preview <port>\` — smart preview (asks device) · \`!preview <port> local\` — localhost link · \`!preview <port> phone\` — tunnel + magic link · \`!preview stop\`\n` +
      `**Services:** \`!services\` — list PM2 background services · \`!service stop|logs <name>\`\n` +
      `**Config:** \`!config show\` · \`!config turns|continues|timeout <N>\` — per-channel limits\n` +
      `**Other:** \`!email <request>\` · \`!imagine <desc>\` · \`!ainews\`\n\n` +
      `Just type what you want built. Claude runs autonomously — reads, writes, commits, pushes. Use \`!stop\` to interrupt, \`!clear\` to start over.\n\n` +
      `Current: **${state.identity.name}** | ${state.personality} | \`${state.cwd}\` | ${state.busy ? '🔄 WORKING' : (state.sessionId ? '💤 idle' : '⚫ no session')}`;
    await ctx.sendLongMessage(message, helpText, state.cwd);
  }
};
