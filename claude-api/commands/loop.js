const fs = require('fs');
const path = require('path');

module.exports = {
  name: '!loop',
  aliases: [],
  adminOnly: false,
  description: 'Run Claude in an autonomous loop until task is done',
  async run(message, arg, state, ctx) {
    if (!arg) {
      await message.reply('Usage: `!loop <task description>` — runs Claude in a loop until the task is done (max 10 iterations).');
      return;
    }
    if (state.busy || state.loopActive) {
      await message.reply('Already working. Use `!stop` first.');
      return;
    }

    const maxIterations = 10;
    const personalityFile = ctx.getPersonalityFile(state.personality);
    // Signal-only: no streaming proxy. The adapter handles message sends directly.
    const proxy = null;
    const channelId = message.channel.id;
    const nsPath = path.join(state.cwd, 'NextSteps.md');

    // Signal sender helper — routes everything through the Signal adapter.
    const send = (text) => ctx._sreply(message, text);

    // L-Fix-2: hold loopActive + busy for the ENTIRE loop.
    state.loopActive = true;
    state.busy = true;
    ctx.saveChannelState(channelId, state, { critical: true });

    await message.reply(`Starting autonomous loop: "${arg.substring(0, 100)}"\nMax ${maxIterations} iterations · cost cap $${ctx.MAX_LOOP_COST_USD} · wallclock cap ${Math.round(ctx.MAX_LOOP_WALLCLOCK_MS / 60000)}m · daily cap ${ctx.MAX_LOOP_ITERATIONS_PER_DAY}. Use \`!stop\` to interrupt.\nWrite \`<<TASK_COMPLETE>>\` in NextSteps.md to signal done.`);

    // M3: record wall-start so we can bail even if individual iterations
    // keep returning successfully within their own 90m hard cap.
    const loopStartedAt = Date.now();

    // L-Fix-1: top-level try/catch — no more silent error swallowing.
    (async () => {
      let totalCost = 0;
      let lastNsHash = null;
      let unchangedIterations = 0;
      let exitReason = 'max-iterations';

      try {
        for (let i = 1; i <= maxIterations; i++) {
          // L-Fix-2: !stop sets loopActive=false; honor it between iterations.
          if (!state.loopActive) {
            exitReason = 'user-stopped';
            break;
          }

          // M3: hard wallclock ceiling across the whole !loop run.
          if (Date.now() - loopStartedAt > ctx.MAX_LOOP_WALLCLOCK_MS) {
            await send(`🛑 !loop wallclock cap reached (${Math.round(ctx.MAX_LOOP_WALLCLOCK_MS / 60000)}m) — stopping. Total cost: $${totalCost.toFixed(4)}.`);
            exitReason = 'wallclock-cap';
            break;
          }

          // M3: per-channel daily iteration counter.
          const iterationsToday = ctx._bumpLoopIterationCount(channelId);
          if (iterationsToday > ctx.MAX_LOOP_ITERATIONS_PER_DAY) {
            await send(`🛑 !loop daily iteration cap reached (${ctx.MAX_LOOP_ITERATIONS_PER_DAY}) — try again tomorrow. Total cost this run: $${totalCost.toFixed(4)}.`);
            exitReason = 'daily-iter-cap';
            break;
          }

          // L-Fix-3 + L-Fix-4: done detection at start of every iteration after the first.
          if (i > 1 && fs.existsSync(nsPath)) {
            const ns = fs.readFileSync(nsPath, 'utf-8');
            if (ns.includes('<<TASK_COMPLETE>>')) {
              await send(`*Loop completed after ${i - 1} iteration${i === 2 ? '' : 's'} — \`<<TASK_COMPLETE>>\` sentinel found in NextSteps.md. Total cost: $${totalCost.toFixed(4)}.*`);
              exitReason = 'sentinel';
              break;
            }
            const crypto = require('crypto');
            const nsHash = crypto.createHash('sha256').update(ns).digest('hex');
            if (lastNsHash && nsHash === lastNsHash) {
              unchangedIterations++;
              if (unchangedIterations >= 2) {
                await send(`*Loop appears stalled — NextSteps.md unchanged for 2 iterations. Stopping after ${i - 1} iterations. Total cost: $${totalCost.toFixed(4)}.*`);
                exitReason = 'idle';
                break;
              }
            } else {
              unchangedIterations = 0;
            }
            lastNsHash = nsHash;
          } else if (i === 1 && fs.existsSync(nsPath)) {
            const crypto = require('crypto');
            lastNsHash = crypto.createHash('sha256').update(fs.readFileSync(nsPath, 'utf-8')).digest('hex');
          }

          // L-Fix-5: cumulative cost cap.
          if (totalCost > ctx.MAX_LOOP_COST_USD) {
            await send(`*Loop bailed: cumulative cost $${totalCost.toFixed(4)} exceeds cap of $${ctx.MAX_LOOP_COST_USD}. Update NextSteps.md is up to Claude. Resume manually if needed.*`);
            exitReason = 'cost-cap';
            break;
          }

          const iterPrompt = i === 1
            ? `${arg}\n\nThis is iteration 1 of an autonomous loop (max ${maxIterations}). When the task is FULLY DONE, write the literal token "<<TASK_COMPLETE>>" on its own line in NextSteps.md. Otherwise, update NextSteps.md with progress and what's left.`
            : `Continue working on this task: "${arg}"\n\nThis is iteration ${i}/${maxIterations}. Read NextSteps.md for context from previous iterations. When the task is FULLY DONE, write the literal token "<<TASK_COMPLETE>>" on its own line in NextSteps.md. Otherwise, update NextSteps.md with progress and what's left.`;

          // L-Fix-6: per-iteration retry on transient error.
          const runIteration = async () => ctx.runClaudeWithContinuation(iterPrompt, {
            sessionId: state.sessionId,
            personalityFile,
            identity: state.identity,
            cwd: state.cwd,
            channelState: state,
          }, proxy);

          let result;
          state.activeTask = { prompt: iterPrompt.substring(0, 500), channelId, startedAt: new Date().toISOString(), resumeAttempts: 0 };
          ctx.saveChannelState(channelId, state, { critical: true });

          try {
            result = await runIteration();
          } catch (err) {
            await send(`*Loop iteration ${i} hit an error (${err.message.substring(0, 150)}). Retrying once after 30s...*`);
            await new Promise(r => setTimeout(r, 30000));
            if (!state.loopActive) {
              exitReason = 'user-stopped';
              break;
            }
            try {
              result = await runIteration();
            } catch (retryErr) {
              await send(`*Loop iteration ${i} failed twice: ${retryErr.message.substring(0, 200)}. Stopping.*`);
              ctx.sendErrorAlert(retryErr, { source: '!loop iteration retry', channel: channelId });
              exitReason = 'iteration-error';
              break;
            }
          }

          if (result.sessionId) state.sessionId = result.sessionId;
          if (result.cost) totalCost += result.cost;

          if (result.stopped) {
            await send('*Loop stopped by user.*');
            exitReason = 'user-stopped';
            break;
          }

          await ctx.sendLongMessage(message, result.text, state.cwd);
          await send(`*— Loop iteration ${i}/${maxIterations} complete · cumulative $${totalCost.toFixed(4)} —*`);

          // L-Fix-7: configurable cooldown.
          await new Promise(r => setTimeout(r, ctx.LOOP_ITERATION_COOLDOWN_MS));
        }

        if (exitReason === 'max-iterations') {
          await send(`*Loop hit ${maxIterations} iteration limit without seeing <<TASK_COMPLETE>>. Total cost: $${totalCost.toFixed(4)}. Send another message to continue.*`);
        }
      } catch (err) {
        // L-Fix-1: top-level safety net — any unhandled error goes here.
        console.error('[!loop] Unhandled error:', err);
        ctx.sendErrorAlert(err, { source: '!loop top-level', channel: channelId });
        try {
          await send(`*Loop crashed: ${err.message.substring(0, 300)}*`).catch(() => {});
        } catch {}
      } finally {
        // ONLY place that clears loopActive — restores normal channel state.
        state.loopActive = false;
        state.busy = false;
        state.startedAt = null;
        state.progress = ctx.freshProgress();
        state.activeTask = null;
        ctx.saveChannelState(channelId, state, { critical: true });
        // Drain any messages queued during the loop so they don't sit forever.
        if (state.queue.length > 0) {
          try { await ctx.processQueue(state); } catch (e) { console.error('[!loop] post-loop drain error:', e.message); }
        }
      }
    })().catch(err => {
      // Belt-and-suspenders: if even the IIFE wrapper throws, log it.
      console.error('[!loop] IIFE rejection:', err);
      state.loopActive = false;
      state.busy = false;
      ctx.saveChannelState(channelId, state, { critical: true });
    });
  }
};
