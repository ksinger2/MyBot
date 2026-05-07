const schedule = require('node-schedule');
const { loadSchedules, updateSchedule } = require('./schedules-storage');

// Track active jobs so we can cancel them
const activeJobs = new Map(); // scheduleId -> node-schedule Job

/**
 * Start all saved schedules on bot startup.
 *
 * SAFETY: Any legacy "Concert Price Tracker" schedule that lacks
 * `subtype === 'concert-tracker'` is force-disabled here. The legacy
 * format stored a free-text prompt that was fed to Claude, which led
 * to hallucinated concerts (including shows by dead artists). Until
 * the user re-runs the !concerttracker wizard (which now writes a
 * structured payload), these rows must NOT fire. Belt + suspenders:
 * the dispatch handler also rejects them.
 */
function startAllSchedules() {
  const schedules = loadSchedules();
  console.log(`Loading ${schedules.length} saved schedule(s)...`);
  for (const sched of schedules) {
    if (_isLegacyConcertTracker(sched)) {
      if (sched.active) {
        console.warn(`  Schedule #${sched.id}: "${sched.description}" — LEGACY concert-tracker (no payload), force-disabling. User must re-run !concerttracker.`);
        try { updateSchedule(sched.id, sched.userId, { active: false }); } catch {}
        sched.active = false;
      }
    }
    registerJob(sched);
  }
}

function _isLegacyConcertTracker(sched) {
  if (sched.subtype === 'concert-tracker') return false; // new format, OK
  if (typeof sched.description !== 'string') return false;
  return sched.description.startsWith('Concert Price Tracker');
}

/**
 * Register a single schedule as a node-schedule job
 */
function registerJob(sched) {
  // Cancel existing job if re-registering
  if (activeJobs.has(sched.id)) {
    activeJobs.get(sched.id).cancel();
  }

  const job = schedule.scheduleJob(
    { rule: sched.cronRule, tz: sched.timezone },
    async () => {
      // Guard: check schedule is still active (may have been toggled off)
      const { getUserSchedules } = require('./schedules-storage');
      const current = getUserSchedules(sched.userId).find(s => s.id === sched.id);
      if (current && !current.active) return;

      if (sched.type === 'dm-task') {
        // ── DETERMINISTIC DISPATCH for typed dm-tasks ────────────
        // Subtype-tagged jobs route to a typed handler that hits real
        // data sources server-side. Claude is NEVER invoked, so there
        // is no fabrication path. Per CLAUDE.md's Determinism Rule:
        // "Prompt instructions are UI polish only — not a reliability
        // mechanism."
        if (sched.subtype === 'concert-tracker') {
          try {
            await runConcertTrackerJob(sched);
          } catch (err) {
            console.error(`[concert-tracker] Job #${sched.id} failed: ${err.message}`);
          }
          return;
        }
        if (sched.subtype === 'media-pulse') {
          try {
            const { runMediaPulseJob } = require('./media-pulse');
            await runMediaPulseJob(sched);
          } catch (err) {
            console.error(`[media-pulse] Job #${sched.id} failed: ${err.message}`);
          }
          return;
        }
        if (sched.subtype === 'email-digest') {
          try {
            const { runEmailDigestJob } = require('./email-digest');
            await runEmailDigestJob(sched);
          } catch (err) {
            console.error(`[email-digest] Job #${sched.id} failed: ${err.message}`);
          }
          return;
        }
        // Hard-stop legacy concert tracker schedules at dispatch
        // even if startup safeguard somehow missed them.
        if (_isLegacyConcertTracker(sched)) {
          console.warn(`[dm-task] Skipping legacy concert tracker schedule #${sched.id} — no payload, would hallucinate. Disabling.`);
          try { updateSchedule(sched.id, sched.userId, { active: false }); } catch {}
          return;
        }

        // Generic dm-task: run prompt through Claude, send to Signal DM.
        // Signal-only — userId is a phone number prefixed with '+'.
        if (!sched.userId || !sched.userId.startsWith('+')) {
          console.warn(`[dm-task] Job #${sched.id} skipped — non-Signal userId`);
          return;
        }
        try {
          const { askClaude, signalAdapter } = require('./bot');
          const { buildProfileContext, getProfile } = require('./user-profiles');
          const profileContext = buildProfileContext(sched.userId);
          const _schedProfile = getProfile(sched.userId);
          console.log(`[dm-task] Running job #${sched.id} "${sched.description}" for Signal user`);

          const dmChannelState = { _channelId: `sched:${sched.id}`, busy: false, process: null };
          const result = await askClaude(sched.message, {
            cwd: '/app',
            maxTurns: 10,
            profileContext,
            isOwner: true,
            channelState: dmChannelState,
            userTimezone: _schedProfile?.timezone || sched.timezone || null,
          });

          if (!result.text) {
            console.log(`[dm-task] Job #${sched.id} returned no text`);
            return;
          }

          if (signalAdapter && signalAdapter.ready) {
            await signalAdapter.sendLongMessage(sched.userId, result.text);
            console.log(`[dm-task] Job #${sched.id} sent to Signal DM`);
          } else {
            console.warn(`[dm-task] Job #${sched.id} — Signal adapter not ready, skipping`);
          }
        } catch (err) {
          console.error(`[dm-task] Job #${sched.id} failed: ${err.message}`);
        }
        return;
      }

      if (sched.type === 'task') {
        // Signal-only autonomous task execution. sched.channelId is a Signal
        // channel id (e.g. `signal:<chatId>`). Skip if the adapter is missing.
        const { signalAdapter, runClaudeWithContinuation, getChannelState, getPersonalityFile, sendLongMessage, freshProgress } = require('./bot');
        const { saveChannelState } = require('./channel-persistence');
        if (!signalAdapter || !signalAdapter.ready) {
          console.warn(`[task] Schedule #${sched.id} skipped — Signal adapter not ready`);
          return;
        }
        const chatId = (sched.channelId || '').replace(/^signal:/, '');
        if (!chatId) return;

        const state = getChannelState(sched.channelId);
        if (state.busy) {
          await signalAdapter.sendMessage(chatId, `Scheduled task skipped — channel busy. Task: "${sched.message.substring(0, 100)}"`).catch(() => {});
          return;
        }

        const personalityFile = getPersonalityFile(state.personality);
        const typingInterval = setInterval(() => signalAdapter.sendTyping(chatId).catch(() => {}), 8000);

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
          }, null);

          if (result.sessionId) {
            state.sessionId = result.sessionId;
            saveChannelState(sched.channelId, state);
          }
          if (result.text && !result.stopped) {
            const fakeMsg = { _signalChatId: chatId, channel: { id: sched.channelId } };
            await sendLongMessage(fakeMsg, result.text, sched.cwd || state.cwd);
          }
        } catch (err) {
          await signalAdapter.sendMessage(chatId, `Scheduled task failed: ${err.message.substring(0, 200)}`).catch(() => {});
        } finally {
          clearInterval(typingInterval);
          state.busy = false;
          state.startedAt = null;
          state.progress = freshProgress();
        }
        return;
      }

      // Reminder — Signal-only.
      try {
        const { signalAdapter } = require('./bot');
        if (!signalAdapter || !signalAdapter.ready) return;
        const recipient = sched.userId && sched.userId.startsWith('+')
          ? sched.userId
          : (sched.channelId || '').replace(/^signal:/, '');
        if (!recipient) return;
        await signalAdapter.sendMessage(recipient, `Scheduled reminder:\n${sched.message}`);
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
/**
 * Deterministic concert-tracker dispatch.
 *
 * Reads the schedule's structured payload, looks up the user's curated
 * artist list, queries Ticketmaster directly via findUpcomingShows(),
 * formats a Signal/Discord-ready message, and sends it. Claude is
 * never invoked in this loop. Dead artists return zero shows from TM
 * and fall into the "no upcoming shows" bucket — the dead-artist
 * hallucination bug is fixed as a side effect of using a real source.
 *
 * Failure modes — all handled honestly, NEVER by guessing:
 *   - No TM API key       → DM the user that key is missing
 *   - No curated list     → DM telling them to run !concerttracker
 *   - Zero shows found    → DM "no upcoming shows" (with the artist
 *                            count so they know we actually checked)
 *   - findUpcomingShows() error → log + skip this run, no DM (don't
 *                                  spam the user with infra errors)
 */
async function runConcertTrackerJob(sched) {
  const { getProfile } = require('./user-profiles');
  const { findUpcomingShows } = require('./plugins/concert-tracker/find-shows');

  const userId = sched.userId;
  const isSignal = typeof userId === 'string' && userId.startsWith('+');
  const payload = sched.payload || {};
  const profile = getProfile(userId) || {};

  // Resolve artists. Default behavior: use the curated list at fire
  // time so `!track add/remove` edits propagate without re-running
  // the wizard. Fallback: payload.artistsOverride.
  let artists = null;
  if (payload.useCuratedList !== false) {
    artists = Array.isArray(profile.concert_tracker_artists)
      ? profile.concert_tracker_artists
      : null;
  }
  if ((!artists || artists.length === 0) && Array.isArray(payload.artistsOverride)) {
    artists = payload.artistsOverride;
  }

  if (!artists || artists.length === 0) {
    await _sendUserMessage(
      sched,
      `Concert tracker fired but you have no tracked artists. Run \`!concerttracker\` or \`!track add <artist>\` to set one up.`,
    );
    return;
  }

  const location = payload.location || profile.location || null;
  if (!location) {
    await _sendUserMessage(
      sched,
      `Concert tracker fired but I don't know your location. Set it via \`!setup\` or re-run \`!concerttracker\`.`,
    );
    return;
  }

  const radiusMiles = payload.radiusMiles || 50;
  const lookAheadMonths = payload.lookAheadMonths || 3;
  const perArtistLimit = payload.perArtistLimit || 5;
  const priceThresholds = Array.isArray(payload.priceThresholds) ? payload.priceThresholds : [];

  console.log(`[concert-tracker] Job #${sched.id} firing for ${isSignal ? 'Signal' : 'Discord'} user — ${artists.length} artists, ${location}, ${radiusMiles}mi`);

  const result = await findUpcomingShows({
    artists,
    location,
    radiusMiles,
    perArtistLimit,
    lookAheadMonths,
    cap: false, // curated lists are honored in full
  });

  if (!result.ok) {
    if (result.reason === 'no-ticketmaster-key') {
      await _sendUserMessage(sched, `Concert tracker can't run — TICKETMASTER_API_KEY is not set on the bot. (Free key at developer.ticketmaster.com.)`);
    } else {
      console.warn(`[concert-tracker] Job #${sched.id} unsuccessful: ${result.reason}`);
    }
    return;
  }

  if (result.shows.length === 0) {
    await _sendUserMessage(
      sched,
      `🎵 **Concert check** — searched all ${result.searchedArtists.length} of your tracked artists across Ticketmaster. **No upcoming shows within ${result.radiusMiles} miles of ${result.city || location} in the next ${result.lookAheadMonths} months.**\n\nThey may be touring elsewhere — try \`!concerts <artist>\` for a wider search, or update your list with \`!track add/remove\`.`,
    );
    console.log(`[concert-tracker] Job #${sched.id}: 0 shows found across ${result.searchedArtists.length} artists`);
    return;
  }

  const messages = _formatConcertTrackerMessage(result, priceThresholds);
  for (const msg of messages) {
    await _sendUserMessage(sched, msg);
  }
  console.log(`[concert-tracker] Job #${sched.id}: ${result.shows.length} shows across ${result.withShowsCount} artists, ${result.noShowArtists.length} no-shows, ${messages.length} message(s) sent`);
}

/**
 * Format a findUpcomingShows() result into one or more Signal/Discord
 * messages, splitting on artist boundaries to avoid mid-artist cuts.
 * Returns an array of strings — caller sends each one in order.
 *
 * Includes Ticketmaster face-value price ranges per show (these come
 * from `priceMin`/`priceMax` on the formatted event). If a show's
 * floor price is under any of `priceThresholds`, it's flagged with a
 * 🚨 ALERT marker. No external scrapers — just TM data — to keep the
 * scheduled path 100% deterministic.
 */
function _formatConcertTrackerMessage(result, priceThresholds = []) {
  const sortedThresholds = [...priceThresholds].sort((a, b) => a - b);

  const header = [
    `🎵 **Upcoming concerts for your tracked artists**`,
    `📍 ${result.radiusMiles}mi of ${result.city || result.location} · next ${result.lookAheadMonths} months`,
    `✅ ${result.withShowsCount} of ${result.searchedArtists.length} artists with shows · ${result.shows.length} total events`,
  ];
  if (sortedThresholds.length > 0) {
    header.push(`💰 Alerting under: $${sortedThresholds.join(', $')}`);
  }
  header.push('');

  const body = [];
  let alertCount = 0;
  for (const [artist, shows] of result.byArtist) {
    body.push(`**${artist}**`);
    for (const s of shows) {
      let priceStr = '';
      if (s.priceMin != null) {
        priceStr = ` · $${Math.round(s.priceMin)}${s.priceMax != null && s.priceMax > s.priceMin ? `–$${Math.round(s.priceMax)}` : ''}`;
      }
      let alertStr = '';
      if (s.priceMin != null && sortedThresholds.length > 0) {
        const hits = sortedThresholds.filter(t => s.priceMin <= t);
        if (hits.length > 0) {
          alertStr = ` 🚨 under $${hits[0]}`;
          alertCount++;
        }
      }
      body.push(`  • ${s.date}${s.time} — ${s.venueName}${s.loc ? ` (${s.loc})` : ''}${priceStr}${alertStr}`);
      if (s.url) body.push(`    ${s.url}`);
    }
  }

  // Insert alert summary near top of header if any
  if (alertCount > 0) {
    header.splice(3, 0, `🚨 ${alertCount} show${alertCount === 1 ? '' : 's'} under your alert threshold!`);
  }

  const footer = [
    '',
    '_Prices are Ticketmaster face-value (no fees, no resale). Use `!prices <artist>` for resale market._',
    'Edit your list with `!track add/remove`, or run `!concerttracker` to reconfigure.',
  ];

  let noShowTail = [];
  if (result.noShowArtists.length > 0) {
    noShowTail = ['', `_No current shows: ${result.noShowArtists.join(', ')}_`];
  }

  // Build single-message view + chunk if needed. Same chunking
  // strategy as commands/concerts.js — split on artist boundaries.
  const allLines = [...header, ...body, ...footer, ...noShowTail];
  const fullLen = allLines.reduce((n, l) => n + l.length + 1, 0);
  if (fullLen <= 1900) {
    return [allLines.join('\n')];
  }

  const messages = [];
  messages.push(header.join('\n'));

  const artistBlocks = [];
  let currentBlock = [];
  for (const line of body) {
    if (line.startsWith('**') && currentBlock.length > 0) {
      artistBlocks.push(currentBlock.join('\n'));
      currentBlock = [line];
    } else {
      currentBlock.push(line);
    }
  }
  if (currentBlock.length > 0) artistBlocks.push(currentBlock.join('\n'));

  let buffer = '';
  for (const block of artistBlocks) {
    if (buffer && (buffer.length + block.length + 2) > 1800) {
      messages.push(buffer);
      buffer = block;
    } else {
      buffer = buffer ? buffer + '\n\n' + block : block;
    }
  }
  if (buffer) messages.push(buffer);
  messages.push([...footer, ...noShowTail].join('\n').trim());
  return messages;
}

/**
 * Send a plain text message to a scheduled job's user via Signal or
 * Discord. Lazy-requires bot.js to avoid bootstrap order issues.
 * Best-effort — logs and continues on any error.
 */
async function _sendUserMessage(sched, text) {
  // Signal-only.
  try {
    const { signalAdapter } = require('./bot');
    if (signalAdapter && signalAdapter.ready) {
      await signalAdapter.sendLongMessage(sched.userId, text);
    } else {
      console.warn(`[concert-tracker] signal adapter not ready, dropping message for #${sched.id}`);
    }
  } catch (err) {
    console.warn(`[concert-tracker] _sendUserMessage failed for #${sched.id}: ${err.message}`);
  }
}

function cancelJob(scheduleId) {
  const job = activeJobs.get(scheduleId);
  if (job) {
    job.cancel();
    activeJobs.delete(scheduleId);
  }
}

function cancelUserJobs(userId) {
  const { getUserSchedules } = require('./schedules-storage');
  const userScheds = getUserSchedules(userId);
  for (const s of userScheds) {
    cancelJob(s.id);
  }
}

module.exports = {
  startAllSchedules,
  registerJob,
  cancelJob,
  cancelUserJobs,
  // Exported for direct invocation by tests + smoke checks.
  runConcertTrackerJob,
  _formatConcertTrackerMessage,
};
