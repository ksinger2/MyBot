module.exports = {
  name: '!btw',
  aliases: [],
  adminOnly: false,
  description: 'Peek at progress while Claude is working',
  async run(message, arg, state, ctx) {
    // !btw is an engineering tool — not useful in Signal group chats
    if (message._signalChatId && state._isGroupChat) {
      return; // silently ignore in groups
    }
    if (!state.busy && !state.process) {
      await message.reply('Nothing running right now.');
      return;
    }
    const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const runtime = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    const p = state.progress;
    const costStr = p._lastCost ? ` | $${p._lastCost.toFixed(4)}` : '';
    const lines = [`**Running ${runtime} | Turn ${p.turnCount || 1}/${ctx.DEFAULT_MAX_TURNS}${costStr}**`];

    if (p.currentTool) {
      const label = ctx.TOOL_LABELS[p.currentTool] || p.currentTool;
      lines.push(`📋 **Main:** ${label}${p.toolDetail ? ` — \`${p.toolDetail}\`` : ''}`);
    } else {
      lines.push(`📋 **Main:** Thinking...`);
    }

    const activeCount = p.activeAgents.size;
    const doneCount = p.completedAgents.length;
    if (activeCount > 0 || doneCount > 0) {
      lines.push('');
      lines.push(`🤖 **Agents (${activeCount} active, ${doneCount} done):**`);
      for (const [, agent] of p.activeAgents) {
        const agentElapsed = Math.round((Date.now() - agent.startedAt) / 1000);
        const toolInfo = agent.lastTool ? `${ctx.TOOL_LABELS[agent.lastTool] || agent.lastTool}` : 'Starting...';
        const typeTag = agent.type ? `\`${agent.type}\` ` : '';
        lines.push(`  🟢 ${typeTag}"${agent.description}" — ${toolInfo} (${agentElapsed}s)`);
      }
      for (const agent of p.completedAgents.slice(-5)) {
        const typeTag = agent.type ? `\`${agent.type}\` ` : '';
        lines.push(`  ✅ ${typeTag}"${agent.description}" — Done`);
      }
    }

    if (p.rawLog.length > 0) {
      lines.push('');
      lines.push(`📜 **Recent (last 10):**`);
      const visible = p.rawLog.slice(-10);
      lines.push('```');
      for (const entry of visible) {
        lines.push(`[${entry.ts}] ${entry.text}`);
      }
      lines.push('```');
    }

    await ctx.sendLongMessage(message, lines.join('\n'), state.cwd);
  }
};
