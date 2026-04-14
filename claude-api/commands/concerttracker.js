const { buildConcertTrackerWizard } = require('../wizards/concert-tracker');

module.exports = {
  name: '!concerttracker',
  aliases: ['!concertsetup', '!trackconcerts'],
  adminOnly: false,
  description: 'Set up a concert price tracking job via interactive DM wizard',
  async run(message, arg, state, ctx) {
    const phone = message._signalSenderId;
    if (!phone) {
      await message.reply('This command only works on Signal.');
      return;
    }

    // If in a group, redirect to DM
    const isGroup = message._signalChatId && message._signalChatId !== message._signalSenderId;
    if (isGroup) {
      try {
        const { signalAdapter } = require('../bot');
        const { getProfile } = require('../user-profiles');
        const profile = getProfile(phone);
        const wizard = buildConcertTrackerWizard();
        // Inject profile into wizard initial data
        wizard.initialData = { _profile: profile || {} };

        // Start wizard in DM
        const { startWizard } = require('../wizard');
        const dmChatId = `signal:${phone}`;
        const { getChannelState } = require('../bot');
        const dmState = getChannelState(dmChatId);

        // Create a DM message proxy for the wizard
        const dmMessage = {
          content: '!concerttracker',
          author: { id: phone, bot: false },
          channel: {
            id: dmChatId,
            send: (text) => signalAdapter.sendMessage(phone, typeof text === 'string' ? text : text.content || ''),
            sendTyping: () => Promise.resolve(),
          },
          reply: (text) => signalAdapter.sendMessage(phone, typeof text === 'string' ? text : text.content || ''),
          _signalSenderId: phone,
          _signalChatId: phone,
        };

        await startWizard(dmState, dmMessage, wizard);
        await message.reply("Check your DMs — I'll walk you through the setup there.");
      } catch (err) {
        await message.reply(`Setup error: ${err.message}`);
      }
      return;
    }

    // In DM — run wizard directly
    const { getProfile } = require('../user-profiles');
    const profile = getProfile(phone);
    const wizard = buildConcertTrackerWizard();
    wizard.initialData = { _profile: profile || {} };

    const { startWizard } = require('../wizard');
    await startWizard(state, message, wizard);
  },
};
