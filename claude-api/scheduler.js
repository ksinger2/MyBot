const schedule = require('node-schedule');
const { loadSchedules } = require('./schedules-storage');

// Track active jobs so we can cancel them
const activeJobs = new Map(); // scheduleId -> node-schedule Job

/**
 * Start all saved schedules on bot startup
 */
function startAllSchedules(client) {
  const schedules = loadSchedules();
  console.log(`Loading ${schedules.length} saved schedule(s)...`);
  for (const sched of schedules) {
    registerJob(sched, client);
  }
}

/**
 * Register a single schedule as a node-schedule job
 */
function registerJob(sched, client) {
  // Cancel existing job if re-registering
  if (activeJobs.has(sched.id)) {
    activeJobs.get(sched.id).cancel();
  }

  const job = schedule.scheduleJob(
    { rule: sched.cronRule, tz: sched.timezone },
    async () => {
      if (sched.type === 'task') {
        // Autonomous task execution
        const channel = await client.channels.fetch(sched.channelId).catch(() => null);
        if (!channel) return;
        const { runClaudeWithContinuation, getChannelState, getPersonalityFile, sendLongMessage, freshProgress } = require('./bot');
        const { saveChannelState } = require('./channel-persistence');
        const state = getChannelState(sched.channelId);

        if (state.busy) {
          await channel.send(`*Scheduled task skipped — channel busy. Task: "${sched.message.substring(0, 100)}"*`).catch(() => {});
          return;
        }

        const personalityFile = getPersonalityFile(state.personality);
        const typingInterval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);

        try {
          state.busy = true;
          state.startedAt = Date.now();
          state.progress = freshProgress();

          const result = await runClaudeWithContinuation(sched.message, {
            sessionId: state.sessionId,
            personalityFile,
            identity: state.identity,
            cwd: sched.cwd || state.cwd,
            channelState: state,
            discordChannel: channel,
          }, channel);

          if (result.sessionId) {
            state.sessionId = result.sessionId;
            saveChannelState(sched.channelId, state);
          }
          if (result.text && !result.stopped) {
            // Send result to channel using a fake message-like object for sendLongMessage
            const fakeMsg = { reply: (opts) => channel.send(opts), channel };
            await sendLongMessage(fakeMsg, result.text, sched.cwd || state.cwd);
          }
        } catch (err) {
          await channel.send(`*Scheduled task failed: ${err.message.substring(0, 200)}*`).catch(() => {});
        } finally {
          clearInterval(typingInterval);
          state.busy = false;
          state.startedAt = null;
          state.progress = freshProgress();
        }
        return;
      }

      // Existing reminder logic
      try {
        // Try DM first
        const user = await client.users.fetch(sched.userId).catch(() => null);
        if (user) {
          const dm = await user.createDM().catch(() => null);
          if (dm) {
            await dm.send(`**Scheduled reminder:**\n${sched.message}`);
            return;
          }
        }
        // Fallback to the channel where it was created
        const channel = client.channels.cache.get(sched.channelId);
        if (channel) {
          await channel.send(`<@${sched.userId}> **Scheduled reminder:**\n${sched.message}`);
        }
      } catch (err) {
        console.error(`Schedule #${sched.id} failed to send:`, err.message);
      }
    }
  );

  if (job) {
    activeJobs.set(sched.id, job);
    console.log(`  Schedule #${sched.id}: "${sched.description}" → ${sched.cronRule}`);
  } else {
    console.error(`  Schedule #${sched.id}: invalid cron rule "${sched.cronRule}"`);
  }
}

/**
 * Cancel and remove a job from the active tracker
 */
function cancelJob(scheduleId) {
  const job = activeJobs.get(scheduleId);
  if (job) {
    job.cancel();
    activeJobs.delete(scheduleId);
  }
}

module.exports = { startAllSchedules, registerJob, cancelJob };
