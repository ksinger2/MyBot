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
