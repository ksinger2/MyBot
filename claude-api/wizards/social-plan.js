const { startWizard } = require('../wizard');
const { buildExtractionPrompt } = require('../link-extractor');
const { buildPlanningContext } = require('../planning-context');
const { createPlanSummaryEmbed, createQuickActions } = require('../discord-components');

/**
 * Start the social plan wizard — triggered when someone drops a link in a channel.
 * @param {object} state - channel state
 * @param {object} message - Discord message
 * @param {Array} extractedLinks - from detectLinks()
 * @param {string[]} channelParticipants - Discord user IDs active in the channel
 */
function startSocialPlanWizard(state, message, extractedLinks, channelParticipants) {
  // Store extracted links and participants on wizard data for later steps
  const linkSummary = extractedLinks.map(l => `[${l.platform}] ${l.url}`).join('\n');
  const participantNames = channelParticipants.filter(id => id !== message.author.id);

  return startWizard(state, message, {
    type: 'social-plan',
    steps: [
      {
        key: 'participants',
        prompt:
          `I found a link! Let me look into it.\n\n` +
          `${linkSummary}\n\n` +
          `Who's going? ` +
          (participantNames.length > 0
            ? `I see ${participantNames.map(id => `<@${id}>`).join(', ')} active here. `
            : '') +
          `@mention anyone to invite, or say **just us** / **solo**.`,
        validate: (input) => {
          if (!input || input.trim().length === 0) return 'Who\'s coming? @mention people, say "just us", or "solo".';
          return true;
        },
      },
      {
        key: 'preferences',
        prompt:
          'Quick preferences — reply with numbers like `1 3 5`:\n' +
          '1. 🐕 Pet-friendly required\n' +
          '2. 💰 Budget-friendly\n' +
          '3. 💎 Splurge / treat ourselves\n' +
          '4. 🏨 Need a hotel (overnight)\n' +
          '5. 🍽️ Find restaurants\n' +
          '6. 🎵 Make a road trip playlist\n' +
          '7. 📅 Check our calendars\n' +
          '8. 🚗 Driving (directions/parking)\n' +
          '9. ✈️ Flying\n\n' +
          'Or say **plan it** to let me decide!',
        validate: () => true,
      },
      {
        key: 'dates',
        prompt: 'When are you thinking? (e.g. `this Saturday`, `April 12-14`, `flexible`)',
        validate: (input) => {
          if (!input || input.trim().length === 0) return 'Give me a date, range, or say "flexible".';
          return true;
        },
      },
      {
        key: 'playlistVibe',
        prompt:
          'What vibe for the playlist?\n' +
          '1. ⚡ High energy (stay awake!)\n' +
          '2. 😌 Chill vibes\n' +
          '3. 🔀 Mix it up\n' +
          '4. 📍 Match the destination\n\n' +
          'Pick a number:',
        condition: (data) => parsePrefs(data.preferences).has(6),
        validate: (input) => {
          if (!['1', '2', '3', '4'].includes(input?.trim())) return 'Pick 1, 2, 3, or 4.';
          return true;
        },
      },
      {
        key: 'confirm',
        prompt: null, // set dynamically in processSocialPlanStep
        validate: () => true,
        default: '__auto__',
      },
    ],
    onComplete: async (data, msg, channelState) => {
      await executeSocialPlan(data, msg, channelState, extractedLinks, channelParticipants);
    },
  });
}

/** Parse preference string "1 3 5" or "plan it" into a Set of numbers */
function parsePrefs(input) {
  if (!input || input.toLowerCase().includes('plan it')) {
    return new Set([5, 7, 8]); // default: restaurants, calendars, driving
  }
  const nums = new Set();
  for (const m of input.matchAll(/\d/g)) {
    nums.add(parseInt(m[0], 10));
  }
  return nums.size > 0 ? nums : new Set([5, 7, 8]);
}

/** Parse @mentions from text, or return channelParticipants for "just us" */
function resolveParticipants(input, senderId, channelParticipants) {
  const lower = input.toLowerCase().trim();
  if (lower === 'solo' || lower === 'just me') return [senderId];
  if (lower === 'just us' || lower === 'us') {
    return channelParticipants.length > 0 ? channelParticipants : [senderId];
  }
  const mentionPattern = /<@!?(\d+)>/g;
  const ids = new Set([senderId]);
  let match;
  while ((match = mentionPattern.exec(input)) !== null) {
    ids.add(match[1]);
  }
  // If no mentions found, default to channel participants
  if (ids.size === 1 && channelParticipants.length > 1) {
    for (const id of channelParticipants) ids.add(id);
  }
  return [...ids];
}

/**
 * Async step processing — called between wizard steps.
 * Handles calendar checks, plan generation, and playlist creation.
 */
async function processSocialPlanStep(state, message) {
  if (!state.wizard || state.wizard.type !== 'social-plan') return;

  const wiz = state.wizard;
  const step = wiz.steps[wiz.step];
  if (!step) return;

  // Before the confirm step, generate the plan
  if (step.key === 'confirm' && !wiz.data._planGenerated) {
    wiz.data._planGenerated = true;

    const prefs = parsePrefs(wiz.data.preferences);
    const links = wiz.data._extractedLinks || [];

    // Build preference-specific instructions
    const prefInstructions = [];
    if (prefs.has(1)) prefInstructions.push('MUST be pet-friendly. Check pet policies.');
    if (prefs.has(2)) prefInstructions.push('Focus on budget-friendly options.');
    if (prefs.has(3)) prefInstructions.push('Recommend premium/luxury options.');
    if (prefs.has(4)) prefInstructions.push('Find hotel/accommodation options with prices.');
    if (prefs.has(5)) prefInstructions.push('Recommend specific restaurants nearby with cuisine type and price range.');
    if (prefs.has(7)) prefInstructions.push('Check the user\'s Google Calendar for availability.');
    if (prefs.has(8)) prefInstructions.push('Include driving directions, estimated drive time, and parking info.');
    if (prefs.has(9)) prefInstructions.push('Include flight options, airports, and estimated flight time.');

    const destination = links.length > 0
      ? links.map(l => l.url).join(' and ')
      : wiz.data.participants; // fallback

    const planningPrompt = buildPlanningContext(destination, {
      dates: wiz.data.dates,
      petFriendly: prefs.has(1),
    });

    const fullPrompt = planningPrompt + '\n\n## Additional Requirements\n' +
      prefInstructions.join('\n') +
      `\n\nDates: ${wiz.data.dates}` +
      '\n\nKeep the response concise and Discord-friendly. Use bullet points.';

    // Generate the plan via Claude
    try {
      const { askClaude } = require('../bot');
      const personalityFile = state.personality
        ? require('path').join(__dirname, '..', 'personalities', `${state.personality}.md`)
        : null;

      await message.reply('Researching and building your plan...');

      const result = await askClaude(fullPrompt, {
        personalityFile,
        identity: state.identity,
        cwd: state.cwd || '/workspace',
        maxTurns: 20,
      });

      wiz.data._planText = result.text || 'Could not generate plan.';

      // Try to send with embed + quick actions
      try {
        const embed = createPlanSummaryEmbed({
          title: 'Trip Plan',
          description: wiz.data._planText.substring(0, 4000),
        });
        const actions = createQuickActions({ eventId: `social-${Date.now()}` });
        await message.channel.send({ embeds: [embed], components: [actions] });
      } catch {
        // Fallback: send as plain text
        await sendLongMessage(message.channel, wiz.data._planText);
      }

      step.prompt = 'What should I do?\n' +
        '1. 📅 Create calendar events\n' +
        '2. 📤 Send plan to everyone via DM\n' +
        '3. ✅ All of the above\n' +
        '4. 👍 We\'re good!\n\n' +
        (prefs.has(6) ? '5. 🎵 Also make that playlist!\n\n' : '') +
        'Pick a number:';
    } catch (err) {
      console.error('[social-plan] Plan generation failed:', err.message);
      step.prompt = `Plan generation hit an issue: ${err.message.substring(0, 200)}\n\nType **retry** to try again, or **skip** to continue.`;
    }
  }
}

/**
 * Execute final actions after wizard completes.
 */
async function executeSocialPlan(data, message, channelState, extractedLinks, channelParticipants) {
  const choice = data.confirm?.trim();
  const participants = resolveParticipants(data.participants, message.author.id, channelParticipants);
  const prefs = parsePrefs(data.preferences);

  // Send DMs
  if (['2', '3'].includes(choice)) {
    const planText = data._planText || 'No plan generated.';
    let sent = 0;
    for (const userId of participants) {
      if (userId === message.author.id) continue;
      try {
        const user = await message.client.users.fetch(userId);
        const summary = planText.length > 1800
          ? planText.substring(0, 1800) + '\n\n*(truncated — check the channel)*'
          : planText;
        await user.send(`**Trip plan from ${message.author.username}:**\n\n${summary}`);
        sent++;
      } catch (err) {
        console.warn(`[social-plan] Failed to DM ${userId}:`, err.message);
      }
    }
    if (sent > 0) await message.reply(`Sent the plan to ${sent} person(s) via DM!`);
  }

  // Create calendar events
  if (['1', '3'].includes(choice)) {
    await message.reply('To create calendar events, tell me: "create a Google Calendar event for this trip on ' + data.dates + '"');
  }

  // Playlist
  if (choice === '5' || (prefs.has(6) && choice === '3')) {
    try {
      const spotifyPlanner = require('../spotify-planner');
      const vibeMap = { '1': 'high-energy', '2': 'chill', '3': 'mix', '4': 'destination' };
      const mood = vibeMap[data.playlistVibe] || 'mix';
      const stayAwake = data.playlistVibe === '1';

      await message.reply('Creating your collaborative playlist...');
      const result = await spotifyPlanner.generateTripPlaylist(participants, {
        destination: extractedLinks?.[0]?.url || 'road trip',
        driveDuration: 120,
        mood,
        stayAwake,
      });

      if (result.playlistUrl) {
        await message.reply(`**Playlist ready!** ${result.trackCount} tracks\n${result.playlistUrl}`);
      } else {
        await message.reply('Could not create playlist — make sure at least one person has Spotify connected (`!spotify`).');
      }
    } catch (err) {
      console.error('[social-plan] Playlist creation failed:', err.message);
      await message.reply(`Playlist creation failed: ${err.message.substring(0, 200)}`);
    }
  }

  if (choice === '4') {
    await message.reply('Sounds good! Have fun! 🎉');
  }
}

/** Send a long message, splitting into chunks if needed */
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
}

module.exports = { startSocialPlanWizard, processSocialPlanStep };
