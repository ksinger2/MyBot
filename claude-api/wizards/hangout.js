const { startWizard } = require('../wizard');
const userTokens = require('../user-tokens');
const googleAuth = require('../google-auth');
const calendarCoordinator = require('../calendar-coordinator');

/**
 * Start the hangout coordination wizard.
 * Walks users through planning a group hangout with calendar-aware scheduling.
 */
function startHangoutWizard(state, message) {
  return startWizard(state, message, {
    type: 'hangout',
    steps: [
      {
        key: 'description',
        prompt: 'What are we doing? (describe the hangout, or paste a link)',
        validate: (input) => {
          if (!input || input.trim().length === 0) return 'Please describe the hangout or paste a link.';
          return true;
        },
      },
      {
        key: 'mentions',
        prompt: 'Who\'s joining? **@mention** everyone you want to invite.',
        validate: (input) => {
          // Discord mentions look like <@123456789> or <@!123456789>
          const mentionPattern = /<@!?(\d+)>/g;
          const matches = input.match(mentionPattern);
          if (!matches || matches.length === 0) {
            return 'Please @mention at least one person to invite.';
          }
          return true;
        },
      },
      {
        key: 'calendarCheck',
        prompt: 'Checking connected calendars...',
        // This step auto-resolves: the validate function does the work and
        // stores results, then we auto-advance with a synthetic value.
        validate: () => true,
        default: '__auto__',
      },
      {
        key: 'dateRange',
        prompt: 'What date range should I check? (e.g. `tomorrow`, `this weekend`, `March 30 - April 2`)',
        validate: (input) => {
          if (!input || input.trim().length === 0) return 'Please provide a date or date range.';
          return true;
        },
      },
      {
        key: 'timeChoice',
        prompt: null, // dynamically set in onComplete based on availability
        validate: (input) => {
          if (!input || input.trim().length === 0) return 'Please pick an option (1, 2, or 3) or type a custom time.';
          return true;
        },
      },
      {
        key: 'confirm',
        prompt: 'Create calendar events for everyone? Reply **yes** or **no**.',
        validate: (input) => {
          const lower = input.toLowerCase().trim();
          if (!['yes', 'no', 'y', 'n'].includes(lower)) return 'Reply **yes** or **no**.';
          return true;
        },
      },
    ],
    onComplete: async (data, msg, channelState) => {
      await executeHangout(data, msg, channelState);
    },
  });
}

/**
 * Parse @mentions from a message string into an array of Discord user IDs.
 */
function parseMentions(mentionString) {
  const mentionPattern = /<@!?(\d+)>/g;
  const ids = [];
  let match;
  while ((match = mentionPattern.exec(mentionString)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/**
 * Parse a human-readable date range into ISO start/end strings.
 * This is a basic parser; the bot can enhance this with Claude for natural language.
 */
function parseDateRange(input) {
  const now = new Date();
  const lower = input.toLowerCase().trim();

  if (lower === 'tomorrow') {
    const start = new Date(now);
    start.setDate(start.getDate() + 1);
    start.setHours(8, 0, 0, 0);
    const end = new Date(start);
    end.setHours(22, 0, 0, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  if (lower === 'this weekend') {
    const start = new Date(now);
    const dayOfWeek = start.getDay();
    const daysUntilSaturday = (6 - dayOfWeek + 7) % 7 || 7;
    start.setDate(start.getDate() + daysUntilSaturday);
    start.setHours(8, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    end.setHours(22, 0, 0, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  // Try to parse "Month Day - Month Day" or "Month Day-Day" patterns
  const rangeMatch = input.match(/(.+?)\s*[-–]\s*(.+)/);
  if (rangeMatch) {
    const startDate = new Date(rangeMatch[1] + ' ' + now.getFullYear());
    const endDate = new Date(rangeMatch[2] + ' ' + now.getFullYear());
    if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
      startDate.setHours(8, 0, 0, 0);
      endDate.setHours(22, 0, 0, 0);
      return { start: startDate.toISOString(), end: endDate.toISOString() };
    }
  }

  // Fallback: try parsing as a single date, use that day 8am-10pm
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    parsed.setHours(8, 0, 0, 0);
    const end = new Date(parsed);
    end.setHours(22, 0, 0, 0);
    return { start: parsed.toISOString(), end: end.toISOString() };
  }

  // Last resort: next 3 days
  const start = new Date(now);
  start.setHours(8, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + 3);
  end.setHours(22, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Format a time slot for display in Discord.
 */
function formatSlot(slot) {
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const dateOpts = { weekday: 'short', month: 'short', day: 'numeric' };
  const timeOpts = { hour: 'numeric', minute: '2-digit' };
  return `${start.toLocaleDateString('en-US', dateOpts)} ${start.toLocaleTimeString('en-US', timeOpts)} - ${end.toLocaleTimeString('en-US', timeOpts)} (${slot.durationMinutes}min)`;
}

/**
 * Execute the hangout after wizard completion.
 */
async function executeHangout(data, message, channelState) {
  const confirm = data.confirm.toLowerCase().trim();
  if (confirm === 'no' || confirm === 'n') {
    await message.reply('Hangout cancelled. No events created.');
    return;
  }

  const inviteeIds = parseMentions(data.mentions);
  // Include the organizer
  const allUserIds = [message.author.id, ...inviteeIds.filter(id => id !== message.author.id)];

  // Parse date range
  const dateRange = parseDateRange(data.dateRange);

  // Find free slots
  let freeSlots;
  try {
    freeSlots = await calendarCoordinator.findOverlappingFreeTime(allUserIds, dateRange, 30);
  } catch (err) {
    await message.reply(`Could not check calendars: ${err.message}`);
    return;
  }

  // Pick the time slot based on user choice
  let selectedSlot;
  const choice = data.timeChoice.trim();
  const choiceNum = parseInt(choice, 10);

  if (choiceNum >= 1 && choiceNum <= freeSlots.length) {
    selectedSlot = freeSlots[choiceNum - 1];
  } else {
    // Try to parse as a custom time — use 1 hour duration as default
    const customStart = new Date(choice);
    if (!isNaN(customStart.getTime())) {
      const customEnd = new Date(customStart.getTime() + 60 * 60 * 1000);
      selectedSlot = { start: customStart.toISOString(), end: customEnd.toISOString() };
    } else if (freeSlots.length > 0) {
      selectedSlot = freeSlots[0]; // fallback to first option
    } else {
      await message.reply('No available time slots found. Try a different date range.');
      return;
    }
  }

  // Create events
  try {
    const result = await calendarCoordinator.createGroupEvent(
      data.description,
      `Hangout organized via Discord by ${message.author.username}`,
      selectedSlot.start,
      selectedSlot.end,
      allUserIds
    );

    const startDate = new Date(selectedSlot.start);
    const timeStr = startDate.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    let response = `**Hangout scheduled!**\n`;
    response += `**What:** ${data.description}\n`;
    response += `**When:** ${timeStr}\n`;

    if (result.created.length > 0) {
      response += `**Calendar events created for:** ${result.created.map(c => c.email).join(', ')}\n`;
    }
    if (result.failed.length > 0) {
      response += `**Could not create events for** ${result.failed.length} user(s) (not connected or error).\n`;
    }

    await message.reply(response);
  } catch (err) {
    await message.reply(`Failed to create events: ${err.message}`);
  }
}

/**
 * Called between steps to handle the calendar check (step 3) and
 * time options presentation (step 5). This should be integrated
 * into the wizard's step processing by the bot's message handler.
 *
 * The bot should call processHangoutStep() after each wizard step
 * to handle async operations that the simple validate/default flow
 * cannot cover.
 */
async function processHangoutStep(state, message) {
  if (!state.wizard || state.wizard.type !== 'hangout') return;

  const wiz = state.wizard;
  const step = wiz.steps[wiz.step];
  if (!step) return;

  // After calendarCheck step stores its value, send DMs to unconnected users
  if (step.key === 'calendarCheck' || wiz.data.calendarCheck === '__auto__') {
    if (wiz.data.mentions && !wiz.data._calendarChecked) {
      wiz.data._calendarChecked = true;
      const inviteeIds = parseMentions(wiz.data.mentions);
      const allUserIds = [message.author.id, ...inviteeIds];

      const connected = [];
      const notConnected = [];

      for (const userId of allUserIds) {
        if (userTokens.isConnected(userId)) {
          const token = userTokens.getToken(userId);
          connected.push(token?.displayName || userId);
        } else {
          notConnected.push(userId);
        }
      }

      let statusMsg = '';
      if (connected.length > 0) {
        statusMsg += `**Connected calendars:** ${connected.join(', ')}\n`;
      }

      if (notConnected.length > 0) {
        statusMsg += `**Not connected:** ${notConnected.length} user(s) — sending them auth links via DM.\n`;

        // Send DMs with auth links to unconnected users
        for (const userId of notConnected) {
          try {
            const user = await message.client.users.fetch(userId);
            const authUrl = googleAuth.getAuthUrl(userId);
            await user.send(
              `**${message.author.username}** is planning a hangout and wants to check your calendar!\n` +
              `Connect your Google Calendar to participate in scheduling:\n${authUrl}`
            );
          } catch (err) {
            console.error(`[hangout] Could not DM user ${userId}:`, err.message);
          }
        }
      }

      if (statusMsg) {
        await message.reply(statusMsg + '\nProceeding to find available times...');
      }
    }
  }

  // Before the timeChoice step, find and display available slots
  if (step.key === 'timeChoice' && wiz.data.dateRange && !wiz.data._slotsPresented) {
    wiz.data._slotsPresented = true;

    const inviteeIds = parseMentions(wiz.data.mentions);
    const allUserIds = [message.author.id, ...inviteeIds.filter(id => id !== message.author.id)];
    const dateRange = parseDateRange(wiz.data.dateRange);

    try {
      const freeSlots = await calendarCoordinator.findOverlappingFreeTime(allUserIds, dateRange, 30);

      if (freeSlots.length === 0) {
        step.prompt = 'No overlapping free time found in that range. Type a specific date/time to use anyway, or type `cancel` to abort.';
      } else {
        const top3 = freeSlots.slice(0, 3);
        const options = top3.map((slot, i) => `**${i + 1}.** ${formatSlot(slot)}`).join('\n');
        step.prompt = `Here are the best available times:\n${options}\n\nReply with **1**, **2**, **3**, or type a custom date/time.`;
      }
    } catch (err) {
      step.prompt = `Could not check calendars (${err.message}). Type a specific date/time to schedule anyway.`;
    }
  }
}

module.exports = { startHangoutWizard, processHangoutStep };
