module.exports = {
  name: '!remember',
  aliases: [],
  adminOnly: false,
  description: 'Explicitly store a preference or fact — also stores on mentioned users from their perspective',
  async run(message, arg, state, ctx) {
    const phone = message._signalSenderId || null;
    if (!phone) {
      await message.reply('Profiles are Signal-only.');
      return;
    }

    const { addPreference, getProfile } = require('../user-profiles');

    if (!arg || !arg.trim()) {
      await message.reply('Usage: `!remember I\'m allergic to peanuts`');
      return;
    }

    const profile = getProfile(phone);
    if (!profile) {
      await message.reply('No profile found — send me a message on Signal to set up first.');
      return;
    }

    const senderName = profile.name || 'someone';
    const fact = arg.trim();

    // Store on the sender's profile
    addPreference(phone, fact, 'explicit');

    // Also store on any mentioned users' profiles with perspective-flipped text
    const mentions = message._signalMentions || [];
    const storedOn = [senderName];

    for (const m of mentions) {
      const mentionPhone = m.number || null;
      if (mentionPhone && mentionPhone !== phone) {
        const mentionProfile = getProfile(mentionPhone);
        if (mentionProfile) {
          const mentionName = mentionProfile.name || m.name || mentionPhone;
          // Flip perspective in one pass: swap sender ("I") ↔ mentioned user
          // "@Merrisa and I like bowling" → "@Karen and I like bowling"
          const escapedMention = (m.name || mentionName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          let flippedFact = fact;
          // Step 1: Replace "@MentionName and I" → "PLACEHOLDER and I" to avoid double-replace
          // Step 2: Replace remaining @MentionName → "@SenderName"
          // Step 3: Replace PLACEHOLDER → "I" (keeps the mentioned user's perspective)
          //
          // Simpler approach: just swap the two names directly.
          // "@Merrisa and I" → "@Karen and I" (from Merrisa's POV, Karen is the other person)
          flippedFact = flippedFact.replace(new RegExp(`@?${escapedMention}\\s+and\\s+I\\b`, 'gi'), `@${senderName} and I`);
          flippedFact = flippedFact.replace(new RegExp(`\\bI\\s+and\\s+@?${escapedMention}\\b`, 'gi'), `I and @${senderName}`);
          // Catch any remaining standalone @MentionName references
          flippedFact = flippedFact.replace(new RegExp(`@${escapedMention}\\b`, 'gi'), `@${senderName}`);

          addPreference(mentionPhone, flippedFact, 'explicit');
          storedOn.push(mentionName);
        }
      }
    }

    const who = storedOn.length > 1
      ? `Remembered for ${storedOn.join(' & ')}`
      : 'Remembered';
    await message.reply(`${who}: ${fact}`);
  }
};
