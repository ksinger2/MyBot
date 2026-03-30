// wizards/trip-planner.js — Multi-step trip/outing planning wizard
const path = require('path');
const { startWizard } = require('../wizard');
const { buildPlanningContext, formatPlanSummary } = require('../planning-context');

const PERSONALITIES_DIR = path.join(__dirname, '..', 'personalities');
const DEFAULT_PERSONALITY = 'tiffany_pollard';

/**
 * Start the trip planner wizard on a channel.
 * Follows the same pattern as startproject.js.
 *
 * @param {object} state - channel state object (from bot.js getChannelState)
 * @param {object} message - Discord message that triggered the wizard
 */
function startTripPlannerWizard(state, message) {
  return startWizard(state, message, {
    type: 'trip-planner',
    steps: [
      // Step 1: Where/what?
      {
        key: 'destination',
        prompt:
          'Where are you going or what are you doing? Drop a link, a place name, or describe the event.\n' +
          '*(e.g. "Yosemite National Park", "Warriors game March 30", "https://www.eventbrite.com/...")*',
        validate: (input) => {
          if (!input || input.trim().length === 0) {
            return 'Give me something to work with — a place name, event, or link.';
          }
          if (input.trim().length < 3) {
            return 'That\'s too short. Give me a place name, event description, or a link.';
          }
          return true;
        },
      },

      // Step 2: Research (auto-step — the bot gathers info and presents it)
      // This step accepts any reply (even "ok") to continue — the real work
      // happens in onComplete for step 1 data, but the wizard engine is linear,
      // so we use a confirm step after presenting research.
      {
        key: 'researchConfirm',
        prompt: null, // Prompt is sent dynamically during the research phase
        // The wizard engine will call this step's prompt as null, which means
        // we handle the presentation in a custom way via the onStepEnter hook below.
        validate: () => true, // Accept anything — this is a confirmation step
      },

      // Step 3: Who's going?
      {
        key: 'companions',
        prompt:
          'Who\'s going? @mention your friends, or say **solo** if it\'s just you.\n' +
          '*(e.g. "@alex @jordan" or "solo" or "me and 2 friends")*',
        validate: (input) => {
          if (!input || input.trim().length === 0) {
            return 'Who\'s coming? @mention people, say "solo", or give me a headcount.';
          }
          return true;
        },
      },

      // Step 4: When?
      {
        key: 'dates',
        prompt:
          'When are you going? Give me specific dates, a rough timeframe, or say **flexible**.\n' +
          '*(e.g. "April 12-14", "next Saturday", "flexible — any weekend in April")*',
        validate: (input) => {
          if (!input || input.trim().length === 0) {
            return 'I need a date or timeframe. Say "flexible" if you\'re open.';
          }
          return true;
        },
      },

      // Step 5: Generate full plan (auto-confirm step)
      {
        key: 'planConfirm',
        prompt: null, // Sent dynamically after plan generation
        validate: () => true,
      },

      // Step 6: Refinements
      {
        key: 'refinements',
        prompt:
          'Looks good? You can:\n' +
          '- Request changes (e.g. "make it pet-friendly", "add dinner spots", "cheaper options")\n' +
          '- Type **done** to finalize\n' +
          '- Type **cancel** to scrap it',
        validate: (input) => {
          if (!input || input.trim().length === 0) {
            return 'Say **done** to finalize, **cancel** to scrap, or tell me what to change.';
          }
          return true;
        },
      },

      // Step 7: Share / calendar
      {
        key: 'shareAction',
        prompt:
          'Last step! What should I do with this plan?\n' +
          '`1` — Just save it (I\'ll post the final summary here)\n' +
          '`2` — Send a summary DM to everyone going\n' +
          '`3` — Create calendar event + send DMs\n\n' +
          'Reply with **1**, **2**, or **3**.',
        // Only show if not cancelled
        condition: (data) => data.refinements && data.refinements.toLowerCase() !== 'cancel',
        validate: (input) => {
          if (!['1', '2', '3'].includes(input)) {
            return 'Reply with **1**, **2**, or **3**.';
          }
          return true;
        },
      },
    ],

    onComplete: async (data, msg, channelState) => {
      await executeTripPlan(data, msg, channelState);
    },
  });
}

/**
 * Execute the trip plan after wizard completes.
 * Calls askClaude to do the heavy lifting (research, plan generation, sharing).
 */
async function executeTripPlan(data, message, channelState) {
  // Handle cancellation
  if (data.refinements && data.refinements.toLowerCase() === 'cancel') {
    await message.reply('Trip planning cancelled. No worries — just run `!trip` again whenever you\'re ready.');
    return;
  }

  const { askClaude } = require('../bot');

  // Parse companions for DM sending
  const mentionedUsers = parseMentions(data.companions);
  const isSolo = data.companions.toLowerCase().includes('solo') || mentionedUsers.length === 0;

  // Build the final plan prompt
  const planPrompt = buildFinalPlanPrompt(data, isSolo, mentionedUsers);

  try {
    await message.reply('Putting together your final trip plan...');

    const identity = channelState.identity || {
      name: 'My Bot',
      description: 'a helpful AI assistant on Discord.',
    };
    const personalityName = channelState.personality || DEFAULT_PERSONALITY;
    const personalityFile = path.join(PERSONALITIES_DIR, `${personalityName}.md`);

    const result = await askClaude(planPrompt, {
      personalityFile,
      identity,
      cwd: channelState.cwd || '/workspace',
      maxTurns: 15,
    });

    if (!result.text) {
      await message.reply('Plan generation came back empty. Try `!trip` again.');
      return;
    }

    // Post the final plan
    await sendLongMessage(message.channel, result.text);

    // Handle share actions
    if (data.shareAction === '2' || data.shareAction === '3') {
      await sharePlanWithCompanions(message, mentionedUsers, result.text, data);
    }

    if (data.shareAction === '3') {
      await message.reply(
        'To create a calendar event, tell me: "create a Google Calendar event for ' +
          `${data.destination} on ${data.dates}" and I'll set it up.`
      );
    }
  } catch (err) {
    console.error('Trip plan generation failed:', err.message);
    await message.reply('Trip planning hit an error: ' + err.message.substring(0, 200));
  }
}

/**
 * Run the research phase (called between steps 1 and 2).
 * This is invoked by the wizard's step-enter hook or manually
 * after step 1 completes.
 *
 * @param {object} data - wizard data so far
 * @param {object} message - Discord message
 * @param {object} channelState - channel state
 * @returns {string} Research summary text
 */
async function runResearchPhase(data, message, channelState) {
  const { askClaude } = require('../bot');

  const researchPrompt = buildPlanningContext(data.destination);

  const identity = channelState.identity || {
    name: 'My Bot',
    description: 'a helpful AI assistant on Discord.',
  };
  const personalityName = channelState.personality || DEFAULT_PERSONALITY;
  const personalityFile = path.join(PERSONALITIES_DIR, `${personalityName}.md`);

  const result = await askClaude(researchPrompt, {
    personalityFile,
    identity,
    cwd: channelState.cwd || '/workspace',
    maxTurns: 15,
  });

  return result.text || 'Could not find info on that destination.';
}

/**
 * Build the final comprehensive plan prompt.
 */
function buildFinalPlanPrompt(data, isSolo, mentionedUsers) {
  const groupSize = isSolo ? '1 person (solo)' : `${mentionedUsers.length + 1} people`;
  const refinements = data.refinements && data.refinements.toLowerCase() !== 'done'
    ? `\n\nUser refinements to incorporate: ${data.refinements}`
    : '';

  return `You are a trip planner. USE WEB SEARCH to build a complete, actionable plan.

## Trip Details
- **Destination**: ${data.destination}
- **Group size**: ${groupSize}
- **Dates**: ${data.dates}
- **Research notes**: The user already saw a research summary for this destination.
${refinements}

## Your Task
Create a COMPLETE trip plan with these sections. Use Discord markdown. Keep it scannable.

### 1. ITINERARY
- Day-by-day schedule with times
- Include travel time from Alameda, CA
- Suggest departure and return times
- Build in flexibility — don't over-schedule

### 2. TRAVEL OPTIONS
- **Drive**: Route, estimated time, gas cost estimate, parking plan
- **Fly**: If applicable — flights, airport transfers
- **Transit**: If feasible — route details
- Recommend the best option for this group size

### 3. ESTIMATED COSTS (per person)
- Transportation
- Accommodation (if overnight)
- Food & drinks
- Activities/tickets
- **TOTAL estimated range**

### 4. THINGS TO PACK
- Weather-appropriate clothing
- Activity-specific gear
- Essentials for the destination

### 5. FOOD PLAN
- Specific restaurant recommendations near the destination
- Include price range, cuisine type, and whether reservations are needed
- At least one option per meal in the itinerary

### 6. PRO TIPS
- Best time to arrive to avoid crowds
- Money-saving tricks
- Local knowledge / insider tips

Search the web for CURRENT information. Include links to venues, restaurants, and booking sites.
Keep the whole plan under 1500 words. Use bullet points, not paragraphs.`;
}

/**
 * Parse @mentions from a message string.
 * Returns an array of user ID strings.
 */
function parseMentions(text) {
  const mentionRegex = /<@!?(\d+)>/g;
  const ids = [];
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/**
 * Send a plan summary DM to all mentioned companions.
 */
async function sharePlanWithCompanions(message, userIds, planText, data) {
  if (!userIds.length) {
    await message.reply('No @mentioned users to send DMs to (solo trip or no mentions detected).');
    return;
  }

  const MAX_DM_LEN = 1900;
  const summary = planText.length > MAX_DM_LEN
    ? planText.substring(0, MAX_DM_LEN - 30) + '\n\n*(truncated — check the channel for full plan)*'
    : planText;

  let sent = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      const user = await message.client.users.fetch(userId);
      if (user) {
        await user.send(
          `**Trip Plan from ${message.author.username}** — ${data.destination}\n` +
          `Dates: ${data.dates}\n\n${summary}`
        );
        sent++;
      }
    } catch (err) {
      console.warn(`Failed to DM user ${userId}:`, err.message);
      failed++;
    }
  }

  const report = [`Sent plan to ${sent} person(s) via DM.`];
  if (failed > 0) report.push(`${failed} DM(s) failed (they may have DMs disabled).`);
  await message.reply(report.join(' '));
}

/**
 * Send a long message, splitting into chunks if needed.
 */
async function sendLongMessage(channel, text) {
  if (!text || text.length === 0) return;

  if (text.length <= 1900) {
    await channel.send(text);
    return;
  }

  let remaining = text;
  let chunks = 0;
  while (remaining.length > 0 && chunks < 8) {
    if (remaining.length <= 1900) {
      await channel.send(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', 1900);
    if (splitAt < 500) splitAt = 1900;
    await channel.send(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
    chunks++;
  }
  if (remaining.length > 0 && chunks >= 8) {
    await channel.send('*(plan truncated — too long for Discord)*');
  }
}

module.exports = { startTripPlannerWizard, runResearchPhase };
