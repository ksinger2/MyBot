/**
 * !onboard @mention  OR  !onboard +1234567890
 *
 * Owner-only command. Starts a step-by-step onboarding wizard for a specific
 * Signal user — works in group chats. Only that person's replies advance the
 * wizard; other group members can keep chatting normally.
 *
 * Steps: name → location → Google Calendar opt-in (+ OAuth link if yes)
 */
module.exports = {
  name: '!onboard',
  aliases: ['!onboard'],
  adminOnly: false, // has own owner check
  description: 'Start onboarding wizard for a specific Signal user',
  async run(message, arg, state, ctx) {
    const { isSignalOwner } = require('../project-permissions');
    const senderId = message._signalSenderId || message.author?.id;

    if (!isSignalOwner(senderId)) {
      await message.reply('Only the owner can run !onboard.');
      return;
    }

    // ── Resolve target phone ──────────────────────────────────────────────────
    // Prefer a Signal @mention (message._signalMentions from the proxy).
    // Fall back to a raw +phone arg. Mentions may have phone, UUID, or both —
    // accept any non-bot mention and use whatever identifier is available.
    const mentions = (message._signalMentions || []).filter(
      m => (m.number || m.uuid) && m.number !== message._signalBotPhone && m.uuid !== message._signalBotPhone
    );

    let targetPhone = null;
    let targetName = null;

    if (mentions.length > 0) {
      const m = mentions[0];
      targetPhone = (m.number && m.number.startsWith('+')) ? m.number : m.uuid;
      targetName = m.name || null;
    } else {
      const argTrimmed = (arg || '').trim();
      if (argTrimmed.startsWith('+')) targetPhone = argTrimmed;
    }

    if (!targetPhone) {
      await message.reply('Usage: `!onboard @person`  or  `!onboard +1234567890`');
      return;
    }

    // ── Already set up? ───────────────────────────────────────────────────────
    const { getProfile } = require('../user-profiles');
    const existing = getProfile(targetPhone);
    if (existing && existing.setup_complete && existing.name) {
      await message.reply(`${existing.name} (${targetPhone}) is already set up.`);
      return;
    }

    // ── Start wizard ──────────────────────────────────────────────────────────
    const { startSenderWizard } = require('../wizard');
    const { buildOnboardingWizard } = require('../wizards/onboarding');

    // Announce to the group so the target person knows to respond
    const displayName = targetName || (targetPhone.startsWith('+') ? targetPhone : 'there');
    await message.reply(
      `Hey ${displayName} — I'm going to ask you a couple quick questions to get you set up. Go ahead and answer whenever you're ready!`
    );

    await startSenderWizard(state, message, buildOnboardingWizard(targetPhone), targetPhone);
  },
};
