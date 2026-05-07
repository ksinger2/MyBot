const fs = require('fs');
const path = require('path');
const { readEncryptedJson } = require('../encrypted-json');

module.exports = {
  name: '!testas',
  aliases: ['!impersonate'],
  adminOnly: true,
  description: 'Test as another user (!testas Merrisa: message here)',
  async run(message, arg, state, ctx) {
    const reply = ctx._dreply || ((m, t) => m.reply(t));

    const match = (arg || '').match(/^(\S+)\s*:\s*(.+)/s);
    if (!match) {
      await reply(message, 'Usage: `!testas <name>: <message>`\nExample: `!testas Merrisa: put a brunch on my calendar`\n\nRuns the message through the full pipeline as that sandbox user (UUID resolution, tool access, etc.) but sends responses back to you.');
      return;
    }

    const targetName = match[1];
    const testMessage = match[2].trim();

    let sandboxConfig;
    try {
      sandboxConfig = readEncryptedJson('/app/data/sandbox-users.json', 'mybot-sandbox-users');
    } catch {
      await reply(message, 'Could not read sandbox config.');
      return;
    }

    let targetPhone = null;
    let targetEntry = null;
    for (const [id, entry] of Object.entries(sandboxConfig)) {
      if (entry.name.toLowerCase() === targetName.toLowerCase()) {
        targetPhone = id;
        targetEntry = entry;
        break;
      }
    }

    if (!targetEntry) {
      const names = Object.values(sandboxConfig).map(e => e.name).join(', ');
      await reply(message, `No sandbox user named "${targetName}". Available: ${names || 'none'}`);
      return;
    }

    // Resolve phone → UUID (mimics real Signal behavior where newer clients only send UUID)
    let simulatedSenderId = targetPhone;
    try {
      const uuidMap = readEncryptedJson('/app/data/signal-uuid-phone.json', 'mybot-signal-uuid-phone');
      const uuids = uuidMap.byPhone?.[targetPhone] || [];
      if (uuids.length > 0) simulatedSenderId = uuids[0];
    } catch {}

    await reply(message, `Testing as **${targetEntry.name}** (sender: ${simulatedSenderId.substring(0, 8)}...)...\n"${testMessage.substring(0, 120)}${testMessage.length > 120 ? '...' : ''}"`);

    // Owner's real chat ID — responses go here
    const ownerChatId = message._signalChatId
      || message.channel?.id?.replace(/^signal:/, '');

    const syntheticMsg = {
      id: String(Date.now()),
      platform: 'signal',
      chatId: ownerChatId,
      senderId: simulatedSenderId,
      senderName: targetEntry.name,
      text: testMessage,
      attachments: [],
      mentions: [],
      timestamp: Date.now(),
      raw: {},
    };

    // Use a test-namespaced channel key so it doesn't collide with the
    // owner's real state or the real user's state
    const testChatId = `signal:test-${targetEntry.name.toLowerCase()}`;

    try {
      const bot = require('../bot');
      const testState = bot.getChannelState(testChatId);
      testState.personality = state.personality;
      testState.identity = state.identity;
      bot._dispatchSignalMessage(syntheticMsg, testChatId, testMessage, testState);
    } catch (err) {
      await reply(message, `Test dispatch failed: ${err.message}`);
    }
  },
};
