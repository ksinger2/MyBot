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
      if (result.text) {
        state._lastPlan = {
          text: result.text.substring(0, 3000),
          query: hasImage ? '(image-based event lookup)' : arg,
          timestamp: Date.now(),
          sessionId: result.sessionId,
        };
        if (chatId) ctx.saveChannelState(`signal:${chatId}`, state, { critical: true });
      }

      if (result.text && !result.stopped) {
        await ctx.sendLongMessage(message, result.text, state.cwd);
      }
    } catch (err) {
      console.error('[!plan] Error:', err.message);
      await message.reply(`Event planning hit an error: ${err.message.substring(0, 300)}`).catch(() => {});
      ctx.sendErrorAlert(err, { source: 'plan command', channel: message.channel?.id });
    } finally {
      clearInterval(planTyping);
      state.busy = false;
      state.startedAt = null;
      state.progress = ctx.freshProgress();
    }
  }
};

// --- Prompt builders ---

function _buildEventImagePrompt(imagePath, memberContext, memberPhones, locationContext, extraContext) {
  return `[EVENT PLANNING — !plan with image]

The user sent a photo of an event (poster, flyer, ad, screenshot). Analyze it and do ALL of the following steps. Do not skip any.

IMAGE: ${imagePath}
${extraContext ? `USER SAID: ${extraContext}\n` : ''}
GROUP MEMBERS:
${memberContext || '(just the sender)'}

USER LOCATION: ${locationContext}

---

## COMPLETE ALL STEPS:

### 1. READ THE IMAGE
Use the Read tool on ${imagePath}. Extract: event name, performer/artist, date, time, venue name, any visible pricing.

### 2. VENUE DETAILS
WebSearch the venue. Report:
- Full address
- Approximate distance/drive time from ${locationContext}
- **🪑 SEATING — THIS IS CRITICAL, the user specifically asked about this:**
  - Is it SEATED with assigned chairs, or GENERAL ADMISSION / STANDING?
  - If seated: are there different sections (orchestra, mezzanine, balcony)?
  - If GA: is there any seating at all (balcony, mezzanine with seats)?
  - Note if the seating depends on the event type
- Venue capacity
- Any notable venue info (recently renovated, historic, outdoor, etc.)

### 3. VENUE INTERIOR PHOTO (REQUIRED — user specifically wants to SEE the venue)
WebSearch for "[venue name] interior" or "[venue name] view from seat". Find an image URL (ending in .jpg, .png, or .webp). Then download it:
\`\`\`bash
curl -sL -o /tmp/venue_photo.jpg "<IMAGE_URL>"
\`\`\`
Verify the download worked:
\`\`\`bash
ls -la /tmp/venue_photo.jpg
\`\`\`
Then reference the path /tmp/venue_photo.jpg in your response text — it will be sent as an inline image attachment automatically.

### 4. TICKET PRICES — USE THE CONCERT SCRAPER
First, use the concert-scraper which checks 5 sources in parallel (much faster than manual searches):
\`\`\`bash
curl -s -X POST http://localhost:3400/concerts/prices \\
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"artist": "<ARTIST_NAME>", "venue": "<VENUE_NAME>", "date": "<YYYY-MM-DD>", "city": "<CITY>"}'
\`\`\`
If the scraper returns results, use those. If it's unavailable or returns no data, fall back to WebSearch on StubHub/Ticketmaster/SeatGeek.

Report:
- Price range found
- **🏷️ CHEAPEST OPTION: exact price (fees included if possible), section/row, which site**
- Whether ${memberPhones.length} tickets together are available at that price
- Note any "best value" or "last few" indicators

### 5. CALENDAR AVAILABILITY
Check if ALL group members are free on the event date/time.
For each member with a connected calendar, use:
\`\`\`bash
curl -s -X POST http://localhost:3400/calendar/freebusy \\
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"user_ids": ${JSON.stringify(memberPhones)}, "start": "<EVENT_START_ISO>", "end": "<EVENT_END_ISO>"}'
\`\`\`
Report: ✅ free or ❌ has conflict (and what the conflict is if possible).

### 6. PARKING & TRANSPORTATION
WebSearch for parking/transit near the venue:
- Nearby parking garages + estimated cost
- Street parking availability
- Public transit (BART, Muni, bus — closest stop + walk time)
- Rideshare estimate from ${locationContext}
- Any venue tips (e.g., "arrive early, parking fills up")

### 7. FINAL SUMMARY + ASK FOLLOW-UP
Present everything organized and concise, then ask:
1. "Want me to send links to buy tickets?"
2. "Should I add this to ${memberPhones.length > 1 ? "everyone's" : "your"} calendar?"
3. Any other logistics?

---
IMPORTANT RULES:
- You MUST download a venue photo to /tmp/ and reference the path so it gets sent as an image attachment
- Be SPECIFIC on cheapest tickets — exact $ amount, not ranges
- Check ALL members' calendars
- Keep response organized with headers but not excessively long`;
}

function _buildEventLinkPrompt(enrichedLinks, arg, memberContext, memberPhones, locationContext) {
  const linkContext = enrichedLinks.map(l => `${l.url} (${l.type || 'unknown'}): ${l.title || l.description || 'no metadata'}`).join('\n');
  return `[EVENT PLANNING — !plan with link]

The user shared a link to an event. Research it fully.

LINKS:
${linkContext}

USER SAID: ${arg}

GROUP MEMBERS:
${memberContext || '(just the sender)'}

USER LOCATION: ${locationContext}

Follow the same workflow as an image-based !plan:
1. Open/research the link to get event details (name, date, time, venue)
2. Venue details (address, distance from ${locationContext}, seating type, capacity)
3. Download a venue interior photo to /tmp/ and reference the path
4. Get ticket prices via concert scraper first (curl -s -X POST http://localhost:3400/concerts/prices -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H "Content-Type: application/json" -d '{"artist":"<ARTIST>","venue":"<VENUE>","date":"<YYYY-MM-DD>","city":"<CITY>"}'), fall back to WebSearch if unavailable — highlight CHEAPEST
5. Check all group members' calendars using: curl -s -X POST http://localhost:3400/calendar/freebusy -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H "Content-Type: application/json" -d '{"user_ids": ${JSON.stringify(memberPhones)}, "start": "<START_ISO>", "end": "<END_ISO>"}'
6. Parking & transport (garages, transit, rideshare estimate from ${locationContext})
7. Summary + ask: "Want ticket links?" / "Add to calendars?"

Download a venue photo. Be specific on cheapest tickets. Check ALL calendars.`;
}

function _buildEventTextPrompt(text, memberContext, memberPhones, locationContext) {
  return `[EVENT PLANNING — !plan with description]

The user described an event they want to attend:
"${text}"

GROUP MEMBERS:
${memberContext || '(just the sender)'}

USER LOCATION: ${locationContext}

Follow the full !plan workflow:
1. WebSearch to identify the exact event (name, date, time, venue)
2. Venue details (address, distance from ${locationContext}, seating type, capacity)
3. Download a venue interior photo to /tmp/ and reference the path
4. Get ticket prices via concert scraper first (curl -s -X POST http://localhost:3400/concerts/prices -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H "Content-Type: application/json" -d '{"artist":"<ARTIST>","venue":"<VENUE>","date":"<YYYY-MM-DD>","city":"<CITY>"}'), fall back to WebSearch if unavailable — highlight CHEAPEST
5. Check all group members' calendars using: curl -s -X POST http://localhost:3400/calendar/freebusy -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H "Content-Type: application/json" -d '{"user_ids": ${JSON.stringify(memberPhones)}, "start": "<START_ISO>", "end": "<END_ISO>"}'
6. Parking & transport (garages, transit, rideshare estimate from ${locationContext})
7. Summary + ask: "Want ticket links?" / "Add to calendars?"

Download a venue photo. Be specific on cheapest tickets. Check ALL calendars.`;
}
