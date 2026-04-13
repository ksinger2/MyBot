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
          console.log(`[remember-flip] fact="${fact}" mentionName="${mentionName}" senderName="${senderName}" m.uuid="${m.uuid}" m.name="${m.name}"`);
          let flippedFact = fact;

          // Step 0: replace any raw @uuid in the text with @mentionName so the
          // flip regexes below can match by name regardless of resolution failures.
          if (m.uuid) {
            const escapedUuid = m.uuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            flippedFact = flippedFact.replace(new RegExp(`@${escapedUuid}`, 'gi'), `@${mentionName}`);
          }

          // Flip perspective: replace @MentionName → @SenderName so from the
          // mentioned user's POV, Karen becomes the referenced person.
          const escapedMention = mentionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Handle "X and I" / "I and X" compound patterns first
          flippedFact = flippedFact.replace(new RegExp(`@?${escapedMention}\\s+and\\s+I\\b`, 'gi'), `@${senderName} and I`);
          flippedFact = flippedFact.replace(new RegExp(`\\bI\\s+and\\s+@?${escapedMention}\\b`, 'gi'), `I and @${senderName}`);
          // Catch any remaining @MentionName or bare MentionName references
          flippedFact = flippedFact.replace(new RegExp(`@${escapedMention}(?=\\s|$|[^a-zA-Z0-9_])`, 'gi'), `@${senderName}`);

          console.log(`[remember-flip] flippedFact="${flippedFact}"`);
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
