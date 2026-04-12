/**
 * !listen — toggle whether the bot responds to every message in a group chat
 * or only to @mentions / !commands.
 *
 * Per-channel setting, persisted across restarts via channel-persistence.
 * Only meaningful in group chats (DMs always respond to everything).
 */
module.exports = {
  name: '!listen',
  aliases: ['!listenall', '!listening'],
  adminOnly: false,
  description: 'Toggle responding to all group messages vs only @mentions',
  async run(message, arg, state, ctx) {
    const reply = ctx._dreply || ((m, t) => m.reply(t));
    const channelId = message.channel?.id || message._signalChatId || state?._channelId;

    const sub = (arg || '').trim().toLowerCase();

    if (sub === 'on') {
      state.listenToAll = true;
    } else if (sub === 'off') {
      state.listenToAll = false;
    } else {
      // Toggle
      state.listenToAll = !state.listenToAll;
    }

    ctx.saveChannelState(channelId, state);

    if (state.listenToAll) {
      await reply(message, '👂 Now listening to **all messages** in this chat. Use `!listen off` to go back to mentions-only.');
    } else {
      await reply(message, '🔇 Now only responding to **@mentions** and **!commands**. Use `!listen on` to listen to everything.');
    }
  },
};
