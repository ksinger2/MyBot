module.exports = {
  name: '!plan',
  aliases: ['!planit'],
  adminOnly: false,
  description: 'Send a photo of an event poster/flyer (or a link) and get full event research: tickets, venue, calendars, transport',
  async run(message, arg, state, ctx) {
    if (state.busy) {
      await message.reply('Already working. Use `!stop` first.');
      return;
    }

    const chatId = message._signalChatId || message.channel?.id?.replace(/^signal:/, '');
    const isGroup = chatId && !chatId.startsWith('+');

    // Detect attached images
    const imageAttachments = (message.attachments || []).filter(a => a.localPath && a.type?.startsWith('image/'));
    const hasImage = imageAttachments.length > 0;

    if (!hasImage && !arg) {
      await message.reply('Send a photo of an event poster/flyer with !plan — or `!plan <link or description>`. I\'ll look up tickets, venue, seating, calendars, parking & transport.');
      return;
    }

    // --- Gather group member info for calendar checks ---
    let memberContext = '';
    let memberPhones = [];
    const senderPhone = message._signalSenderId || chatId;

    if (isGroup && ctx.signalAdapter) {
      try {
        const groupInfo = await ctx.signalAdapter.getGroupInfo(chatId);
        const members = groupInfo?.members || [];
        const userProfiles = require('../user-profiles');
        const userTokens = require('../user-tokens');
        const botPhone = process.env.SIGNAL_PHONE_NUMBER;

        for (const m of members) {
          const phone = m.phone || m.number || m;
          if (typeof phone !== 'string' || phone === botPhone) continue;
          memberPhones.push(phone);
          const profile = userProfiles.getProfile(phone);
          const calConnected = userTokens.isConnected(phone);
          const name = profile?.name || phone;
          memberContext += `- ${name} (${phone}): calendar ${calConnected ? 'CONNECTED' : 'not connected'}\n`;
        }
      } catch (err) {
        console.warn('[!plan] Failed to get group members:', err.message);
        memberPhones.push(senderPhone);
      }
    } else {
      memberPhones.push(senderPhone);
      try {
        const userProfiles = require('../user-profiles');
        const userTokens = require('../user-tokens');
        const profile = userProfiles.getProfile(senderPhone);
        const calConnected = userTokens.isConnected(senderPhone);
        memberContext = `- ${profile?.name || senderPhone} (${senderPhone}): calendar ${calConnected ? 'CONNECTED' : 'not connected'}\n`;
      } catch {}
    }

    // --- Get user's location from profile ---
    let locationContext = 'San Francisco Bay Area';
    try {
      const userProfiles = require('../user-profiles');
      const profile = userProfiles.getProfile(senderPhone);
      if (profile?.location || profile?.city) {
        locationContext = profile.location || profile.city;
      }
    } catch {}

    // --- Build the prompt ---
    let planPrompt;

    if (hasImage) {
      const imagePath = imageAttachments[0].localPath;
      planPrompt = _buildEventImagePrompt(imagePath, memberContext, memberPhones, locationContext, arg);
    } else {
      // Link or text-based planning (existing behavior, enhanced)
      const { detectLinks, buildSmartPrompt, enrichLinks } = require('../link-extractor');
      const links = detectLinks(arg);
      if (links.length > 0) {
        const enriched = await enrichLinks(links);
        planPrompt = _buildEventLinkPrompt(enriched, arg, memberContext, memberPhones, locationContext);
      } else {
        planPrompt = _buildEventTextPrompt(arg, memberContext, memberPhones, locationContext);
      }
    }

    // --- Execute ---
    state.busy = true;
    state.startedAt = Date.now();
    state.progress = ctx.freshProgress();

    // Persist activeTask so auto-resume picks up after rebuild
    state.activeTask = {
      prompt: hasImage ? `!plan (image: ${imageAttachments[0]?.name || 'photo'}) ${arg || ''}`.trim() : `!plan ${arg}`,
      channelId: chatId,
      senderId: senderPhone,
      senderName: message._senderName || senderPhone,
      startedAt: new Date().toISOString(),
      resumeAttempts: 0,
    };
    if (chatId) ctx.saveChannelState(`signal:${chatId}`, state, { critical: true });

    await ctx._styping(message);
    const planTyping = setInterval(() => { ctx._styping(message).catch(() => {}); }, 8000);

    await ctx._sreply(message, hasImage
      ? 'Analyzing that event — checking venue, tickets, calendars, and transport...'
      : 'Researching that — tickets, venue, calendars, transport...');

    try {
      const personalityFile = ctx.getPersonalityFile(state.personality);
      const channelProxy = ctx.ChannelProxy.fromSignal(ctx.signalAdapter, chatId);
      channelProxy.setGroupChat(isGroup, chatId);

      const result = await ctx.runClaudeWithContinuation(planPrompt, {
        sessionId: null, // Fresh session for clean research
        personalityFile,
        identity: state.identity,
        cwd: state.cwd,
        channelState: state,
        channelProxy,
        isOwner: false,
        ownerDmMode: false,
        model: 'sonnet',
        maxTurns: 30,
        streamReplies: true,
        readOnly: false, // needs Bash to download venue images
        userTimezone: null,
      }, channelProxy);

      if (result.sessionId) state.sessionId = result.sessionId;

      // Store the plan result so follow-up messages ("send me a link", "add to
      // calendar") have deterministic context about which event was just planned.
      // This is injected into the system prompt by bot.js for subsequent messages.
      // Store the plan result for deterministic follow-ups.
      // Don't re-send text — streamReplies already sent it live.
      if (result.text) {
        state._lastPlan = {
          text: result.text.substring(0, 3000),
          query: hasImage ? '(image-based event lookup)' : arg,
          timestamp: Date.now(),
          sessionId: result.sessionId,
        };
        if (chatId) ctx.saveChannelState(`signal:${chatId}`, state, { critical: true });
      }
    } catch (err) {
      console.error('[!plan] Error:', err.message);
      await message.reply(`Event planning hit an error: ${err.message.substring(0, 300)}`).catch(() => {});
      ctx.sendErrorAlert(err, { source: 'plan command', channel: message.channel?.id });
    } finally {
      clearInterval(planTyping);
      state.busy = false;
      state.startedAt = null;
      state.activeTask = null;
      state.progress = ctx.freshProgress();
      if (chatId) ctx.saveChannelState(`signal:${chatId}`, state, { critical: true });
      // Drain any messages that queued while !plan was running
      if (state.queue && state.queue.length > 0) {
        ctx.processQueue(state);
      }
    }
  }
};

// --- Shared output format ---

const OUTPUT_FORMAT = `
OUTPUT FORMAT — Your response MUST be SHORT and use this exact layout. No headers, no tables, no walls of text. Just a clean card:

**<Artist/Event> — <Venue>, <City>**
<Day of week>, <Month Day, Year> · <Time>
<Address> · <drive time> from <user location>
<Seated/GA> · <capacity> cap

🏷️ Cheapest: **$XX on <Site>** (fees included)
Other: $XX <Site>, $XX <Site>

<One line per person>: ✅ free / ❌ conflict

🚗 Parking: <best option + cost>
🚇 Transit: <best route>

Want ticket links? Add to calendars?

That's it. No essays. No venue history. No paragraph descriptions. MAX 15 lines total.
`;

// --- Prompt builders ---

function _buildEventImagePrompt(imagePath, memberContext, memberPhones, locationContext, extraContext) {
  return `[EVENT PLANNING — !plan with image]

Read the image at ${imagePath} to identify the event. Then research it.
${extraContext ? `User also said: ${extraContext}` : ''}

GROUP MEMBERS:
${memberContext || '(just the sender)'}
USER LOCATION: ${locationContext}

RESEARCH STEPS (do all, but keep your RESPONSE short):
1. Read the image → extract artist, date, time, venue
2. WebSearch venue → address, seated vs GA, capacity
3. Download a venue interior photo: curl -sL -o /tmp/venue_photo.jpg "<URL>" — reference /tmp/venue_photo.jpg in response
4. Emit [CONCERT_PRICES: artist="<NAME>" venue="<VENUE>" date="<YYYY-MM-DD>" city="<CITY>"] for ticket prices. Also WebSearch "<artist> <venue> tickets" for more options
5. Note each group member's calendar status
6. One WebSearch for parking/transit near venue
${OUTPUT_FORMAT}`;
}

function _buildEventLinkPrompt(enrichedLinks, arg, memberContext, memberPhones, locationContext) {
  const linkContext = enrichedLinks.map(l => `${l.url}: ${l.title || l.description || 'no metadata'}`).join('\n');
  return `[EVENT PLANNING — !plan with link]

Research this event link: ${linkContext}
User said: ${arg}

GROUP MEMBERS:
${memberContext || '(just the sender)'}
USER LOCATION: ${locationContext}

RESEARCH STEPS (do all, but keep your RESPONSE short):
1. Fetch the link → extract artist, date, time, venue
2. WebSearch venue → address, seated vs GA, capacity
3. Download a venue interior photo: curl -sL -o /tmp/venue_photo.jpg "<URL>" — reference /tmp/venue_photo.jpg in response
4. Emit [CONCERT_PRICES: artist="<NAME>" venue="<VENUE>" date="<YYYY-MM-DD>" city="<CITY>"] for ticket prices. Also WebSearch for more options
5. Note each group member's calendar status
6. One WebSearch for parking/transit near venue
${OUTPUT_FORMAT}`;
}

function _buildEventTextPrompt(text, memberContext, memberPhones, locationContext) {
  return `[EVENT PLANNING — !plan with description]

The user wants to see: "${text}"

GROUP MEMBERS:
${memberContext || '(just the sender)'}
USER LOCATION: ${locationContext}

RESEARCH STEPS (do all, but keep your RESPONSE short):
1. WebSearch to find the exact event (artist, date, time, venue)
2. WebSearch venue → address, seated vs GA, capacity
3. Download a venue interior photo: curl -sL -o /tmp/venue_photo.jpg "<URL>" — reference /tmp/venue_photo.jpg in response
4. Emit [CONCERT_PRICES: artist="<NAME>" venue="<VENUE>" date="<YYYY-MM-DD>" city="<CITY>"] for ticket prices. Also WebSearch for more options
5. Note each group member's calendar status
6. One WebSearch for parking/transit near venue
${OUTPUT_FORMAT}`;
}
