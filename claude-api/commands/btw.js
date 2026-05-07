module.exports = {
  name: '!btw',
  aliases: [],
  adminOnly: false,
  description: 'Peek at progress while Claude is working',
  async run(message, arg, state, ctx) {
    // !btw is an engineering tool — suppress in social group chats,
    // but allow in sandbox-linked groups (co-development).
    if (message._signalChatId && state._isGroupChat) {
      try {
        const { getSandboxForChat } = require('../sandbox');
        if (!getSandboxForChat(message._signalChatId)) return;
      } catch { return; }
    }
    if (!state.busy && !state.process) {
      // Check for background tasks registered by Claude Code
      try {
        const http = require('http');
        const tasks = await new Promise((resolve) => {
          const req = http.request({
            hostname: 'localhost', port: 3400, path: '/internal/background-tasks',
            headers: { 'X-Internal-Token': require('../internal-token').getInternalToken() },
          }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).tasks || []); } catch { resolve([]); } });
          });
          req.on('error', () => resolve([]));
          req.end();
        });
        if (tasks.length > 0) {
          const lines = [`🔄 **Bot idle — ${tasks.length} background task(s) running:**`];
          for (const t of tasks) {
            const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
            const mins = Math.floor(elapsed / 60), secs = elapsed % 60;
            const runtime = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
            lines.push(`  ⏳ "${t.description}" (${runtime})`);
          }
          await message.reply(lines.join('\n'));
          return;
        }
      } catch {}
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

    // Append background tasks from the internal registry (even while bot is busy)
    try {
      const http = require('http');
      const bgTasks = await new Promise((resolve) => {
        const req = http.request({
          hostname: 'localhost', port: 3400, path: '/internal/background-tasks',
          headers: { 'X-Internal-Token': require('../internal-token').getInternalToken() },
        }, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d).tasks || []); } catch { resolve([]); } });
        });
        req.on('error', () => resolve([]));
        req.end();
      });
      if (bgTasks.length > 0) {
        lines.push('');
        lines.push(`🔄 **Background tasks (${bgTasks.length} running):**`);
        for (const t of bgTasks) {
          const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
          const mins = Math.floor(elapsed / 60), secs = elapsed % 60;
          const runtime = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          lines.push(`  ⏳ "${t.description}" (${runtime})`);
        }
      }
    } catch {}

    await ctx.sendLongMessage(message, lines.join('\n'), state.cwd);
  }
};
