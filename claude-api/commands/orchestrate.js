'use strict';

const path = require('path');
const { buildOrchestrationPrompt, listTemplates } = require('../orchestrator');

module.exports = {
  name: '!orchestrate',
  aliases: ['!orch'],
  adminOnly: true,
  description: 'Run a multi-agent orchestrated workflow. `!orchestrate engineering-task Fix the auth flow` or `!orchestrate self-improvement`. Use `!orchestrate` with no args to list templates.',

  async run(message, arg, state, ctx) {
    if (state.busy) {
      await message.reply('Claude is still working. Use `!stop` first.');
      return;
    }

    // No args — list available templates
    if (!arg) {
      const templates = listTemplates();
      const list = templates.map(t => `- **${t.name}** — ${t.description}`).join('\n');
      await message.reply(`Available orchestration templates:\n${list}\n\nUsage: \`!orchestrate <template> <task description>\``);
      return;
    }

    // Parse: first word is template name, rest is task description
    const parts = arg.split(/\s+/);
    const templateName = parts[0].toLowerCase();
    const taskDescription = parts.slice(1).join(' ').trim() || null;

    // Validate template
    const templates = listTemplates();
    const templateNames = templates.map(t => t.name);
    if (!templateNames.includes(templateName)) {
      const list = templates.map(t => `- **${t.name}** — ${t.description}`).join('\n');
      await message.reply(`Unknown template: "${templateName}"\n\nAvailable templates:\n${list}`);
      return;
    }

    // Build orchestration prompt
    const projectName = path.basename(state.cwd || '.');
    const prompt = buildOrchestrationPrompt(templateName, taskDescription, {
      cwd: state.cwd,
      projectName,
    });

    if (!prompt) {
      await message.reply('Failed to build orchestration prompt. This shouldn\'t happen — check orchestrator.js.');
      return;
    }

    // Orchestration always runs in auto mode (coding mode)
    const previousCodingMode = state.codingMode;
    state.codingMode = 'auto';

    // Fresh session for orchestration
    state.sessionId = null;

    const taskLabel = taskDescription
      ? `**${templateName}**: ${taskDescription.length > 80 ? taskDescription.substring(0, 80) + '...' : taskDescription}`
      : `**${templateName}**`;
    await message.reply(`Starting orchestration — ${taskLabel}\n*Working directory: \`${state.cwd}\`*`);

    const personalityFile = ctx.getPersonalityFile(state.personality);
    await ctx._styping(message);
    const typingInterval = setInterval(() => { ctx._styping(message).catch(() => {}); }, 8000);

    state.busy = true;
    state.startedAt = Date.now();
    state.progress = ctx.freshProgress();

    try {
      const result = await ctx.runClaudeWithContinuation(prompt, {
        personalityFile,
        identity: state.identity,
        cwd: state.cwd,
        channelState: state,
        maxTurns: 100,
      }, null);

      if (result.sessionId) {
        state.sessionId = result.sessionId;
        ctx.saveChannelState(message.channel.id, state);
      }
      if (!result.stopped) {
        await ctx.sendLongMessage(message, result.text, state.cwd);
      }
    } catch (err) {
      const errorMsg = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
      await message.reply(`Orchestration error: ${errorMsg}`).catch(() => {});
      ctx.sendErrorAlert(err, { source: 'orchestrate command', channel: message.channel.id });
    } finally {
      clearInterval(typingInterval);
      state.busy = false;
      state.startedAt = null;
      state.progress = ctx.freshProgress();
      // Restore previous coding mode
      state.codingMode = previousCodingMode;
    }
  }
};
