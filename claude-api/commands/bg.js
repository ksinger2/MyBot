module.exports = {
  name: '!bg',
  aliases: ['!background'],
  adminOnly: true,
  description: 'Run a task in the background — check on it later with !bgtasks',
  async run(message, arg, state, ctx) {
    if (!arg || !arg.trim()) {
      await message.reply('Usage: `!bg <task description>` — starts a background task you can check on later.');
      return;
    }

    const taskId = `bg-${Date.now().toString(36)}`;
    const bgTask = {
      id: taskId,
      description: arg.trim().substring(0, 200),
      startedAt: Date.now(),
      status: 'running',
      result: null,
      cost: 0,
      numTurns: 0,
    };

    if (!state._bgTasks) state._bgTasks = new Map();
    state._bgTasks.set(taskId, bgTask);

    await message.reply(`Background task started: **${bgTask.description}**\nID: \`${taskId}\`\nUse \`!bgtasks\` to check status.`);

    // Fire and forget — run the task asynchronously
    (async () => {
      try {
        const bgChannelState = { _channelId: `bg:${taskId}`, busy: false, process: null };
        bgTask._channelState = bgChannelState;
        const result = await ctx.askClaude(arg.trim(), {
          personalityFile: ctx.getPersonalityFile(state.personality),
          identity: state.identity,
          cwd: state.cwd,
          maxTurns: state.config?.maxTurns || 30,
          channelState: bgChannelState,
          readOnly: false,
          model: 'sonnet',
          ownerDmMode: true,
          isOwner: true,
        });

        bgTask.status = result.stopped ? 'stopped' : 'done';
        bgTask.result = (result.text || '').substring(0, 2000);
        bgTask.cost = result.cost || 0;
        bgTask.numTurns = result.numTurns || 0;
        bgTask.completedAt = Date.now();

        // Notify user
        const elapsed = Math.round((bgTask.completedAt - bgTask.startedAt) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        const signalChatId = message._signalChatId || message.channel?.id?.replace(/^signal:/, '');
        if (signalChatId && ctx.signalAdapter) {
          const summary = bgTask.result.length > 500 ? bgTask.result.substring(0, 497) + '...' : bgTask.result;
          await ctx.signalAdapter.sendLongMessage(signalChatId,
            `✅ Background task done: **${bgTask.description}**\n${timeStr} · ${bgTask.numTurns} turns · $${bgTask.cost.toFixed(4)}\n\n${summary}`
          );
        }
      } catch (err) {
        bgTask.status = 'error';
        bgTask.result = err.message;
        bgTask.completedAt = Date.now();
        console.error(`[bg-task] ${taskId} failed:`, err.message);
      }
    })();
  }
};
