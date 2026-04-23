module.exports = {
  name: '!session',
  aliases: ['!sesh'],
  adminOnly: false,
  description: 'Show current session info — ID, age, cumulative cost/turns',
  async run(message, arg, state, ctx) {
    if (!state.sessionId) {
      await message.reply('No active session. Send a message to start one.');
      return;
    }

    const lines = [];
    lines.push(`**Session:** \`${state.sessionId.substring(0, 12)}…\``);
    lines.push(`**Personality:** ${state.identity?.name || state.personality}`);
    lines.push(`**Workspace:** \`${state.cwd}\``);

    if (state.sessionStartedAt) {
      const ageMs = Date.now() - state.sessionStartedAt;
      const mins = Math.floor(ageMs / 60000);
      const hrs = Math.floor(mins / 60);
      lines.push(`**Age:** ${hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`}`);
    }

    const turns = state.sessionTurns || 0;
    const cost = state.sessionCost || 0;
    lines.push(`**Turns:** ${turns}`);
    lines.push(`**Cost:** $${cost.toFixed(4)}`);

    const maxCost = state.config?.maxSessionCost;
    if (maxCost) {
      const pct = Math.round((cost / maxCost) * 100);
      lines.push(`**Cost cap:** $${maxCost.toFixed(2)} (${pct}% used)`);
    }

    if (state.busy) lines.push('**Status:** 🔄 Working');
    else lines.push('**Status:** 💤 Idle');

    if (state.queue?.length > 0) {
      lines.push(`**Queued:** ${state.queue.length} message(s)`);
    }

    const recentCount = (state.recentMessages || []).length;
    if (recentCount > 0) {
      lines.push(`**Context:** ${recentCount} recent messages cached`);
    }

    await message.reply(lines.join('\n'));
  }
};
