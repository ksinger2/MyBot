module.exports = {
  name: '!bgtasks',
  aliases: ['!bgstatus'],
  adminOnly: true,
  description: 'Show status of background tasks',
  async run(message, arg, state, ctx) {
    if (!state._bgTasks || state._bgTasks.size === 0) {
      await message.reply('No background tasks. Use `!bg <task>` to start one.');
      return;
    }

    const lines = [];
    const now = Date.now();
    for (const [id, task] of state._bgTasks) {
      const elapsed = Math.round(((task.completedAt || now) - task.startedAt) / 1000);
      const timeStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
      const icon = task.status === 'running' ? '🔄' : task.status === 'done' ? '✅' : task.status === 'error' ? '❌' : '⏹';
      lines.push(`${icon} \`${id}\` — ${task.description}\n   ${task.status} · ${timeStr}${task.cost ? ` · $${task.cost.toFixed(4)}` : ''}`);
    }

    // If specific task ID requested, show full result
    if (arg && arg.trim()) {
      const task = state._bgTasks.get(arg.trim());
      if (task && task.result) {
        await ctx.sendLongMessage(message, `**${task.description}** (${task.status}):\n\n${task.result}`, state.cwd);
        return;
      }
    }

    await message.reply(`**Background Tasks:**\n${lines.join('\n')}\n\nUse \`!bgtasks <id>\` to see full result.`);

    // Clean up completed tasks older than 1 hour
    for (const [id, task] of state._bgTasks) {
      if (task.completedAt && (now - task.completedAt) > 3600000) {
        state._bgTasks.delete(id);
      }
    }
  }
};
