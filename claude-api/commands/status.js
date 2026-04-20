// !status — lightweight status probe. Bypasses the busy guard so it works
// mid-loop (commands are dispatched before the busy/queue check in bot.js,
// and this handler reads state directly without invoking Claude).
//
// Per-channel by default; `!status all` shows every channel.

const TOOL_LABEL_FALLBACK = {
  Bash: 'Bash', Read: 'Read', Write: 'Write', Edit: 'Edit', Grep: 'Grep',
  Glob: 'Glob', WebFetch: 'WebFetch', WebSearch: 'WebSearch', Task: 'Task',
};

function _fmtElapsed(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m === 0) return `${sec}s`;
  return `${m}m ${sec}s`;
}

function _lastToolName(state, ctx) {
  const p = state.progress || {};
  if (p.currentTool) {
    return (ctx?.TOOL_LABELS || TOOL_LABEL_FALLBACK)[p.currentTool] || p.currentTool;
  }
  if (Array.isArray(p.toolHistory) && p.toolHistory.length > 0) {
    const last = p.toolHistory[p.toolHistory.length - 1];
    const name = typeof last === 'string' ? last : last?.name;
    if (name) return (ctx?.TOOL_LABELS || TOOL_LABEL_FALLBACK)[name] || name;
  }
  return state.busy ? 'thinking' : 'idle';
}

function _statusLine(channelId, state, ctx) {
  const busy = !!state.busy;
  const queueDepth = Array.isArray(state.queue) ? state.queue.length : 0;
  const sinceMs = busy
    ? (state.busySince ? Date.now() - state.busySince
       : state.startedAt ? Date.now() - state.startedAt
       : 0)
    : 0;
  const tool = _lastToolName(state, ctx);
  const cost = state.progress?._lastCost;
  const turn = state.progress?.turnCount;
  const taskExcerpt = (state.activeTask?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  const lines = [];
  lines.push(`📊 Status: ${busy ? 'busy' : 'idle'}`);
  lines.push(`🔄 Task: ${tool}${taskExcerpt ? ` — "${taskExcerpt}${taskExcerpt.length === 60 ? '…' : ''}"` : ''}`);
  lines.push(`💬 Queue: ${queueDepth} ${queueDepth === 1 ? 'message' : 'messages'} waiting`);
  lines.push(`⏱️ Running: ${busy ? _fmtElapsed(sinceMs) : '—'}${turn ? ` (turn ${turn})` : ''}`);
  lines.push(`💰 Cost: ${typeof cost === 'number' ? `$${cost.toFixed(4)}` : '$0.00'}`);
  return lines.join('\n');
}

module.exports = {
  name: '!status',
  aliases: [],
  adminOnly: false,
  description: 'Show current task / queue depth / runtime (bypasses busy)',
  async run(message, arg, state, ctx) {
    const wantAll = (arg || '').trim().toLowerCase() === 'all';

    if (!wantAll) {
      // Per-channel quick status (the common case mid-loop).
      const body = _statusLine(message.channel.id, state, ctx);
      await message.reply(body);
      return;
    }

    // Full multi-channel summary (the previous default).
    const blocks = [];
    for (const [chId, s] of ctx.channels) {
      const header = `**${chId}** — ${s.busy ? '🔄 working' : (s.sessionId ? '💤 idle' : '⚫ no session')}`;
      blocks.push(header + '\n' + _statusLine(chId, s, ctx));
    }
    const footer = `\n\nHard cap: ${ctx.MAX_TIMEOUT / 60000}min | Stall: ${ctx.STALL_THRESHOLDS.thinking / 60000}-${ctx.STALL_THRESHOLDS.browser / 60000}min (tiered) | Check-in: ${ctx.CHECKIN_INTERVAL / 60000}min | Max turns: ${ctx.DEFAULT_MAX_TURNS}`;
    await message.reply((blocks.length ? blocks.join('\n\n') : 'No channels active.') + footer);
  },
};
