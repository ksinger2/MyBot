const { runHeadlessLogin, isLoginInProgress, setLoginInProgress, getTokenExpiryMinutes } = require('../token-refresh');

module.exports = {
  name: '!login',
  aliases: ['!auth', '!reauth'],
  adminOnly: true,
  description: 'Re-authenticate Claude CLI from your phone',
  async run(message, arg, state, ctx) {
    const reply = ctx._dreply || ((m, t) => m.reply(t));

    if (isLoginInProgress()) {
      await reply(message, 'Login already in progress — check your earlier message for the auth URL.');
      return;
    }

    const minsLeft = getTokenExpiryMinutes();
    const statusLine = minsLeft !== null
      ? `Current token: ${minsLeft > 0 ? `${minsLeft}min remaining` : 'EXPIRED'}`
      : 'Current token: unknown status';

    await reply(message, `${statusLine}\n\nStarting auth flow...`);

    try {
      const { process: loginProc, url } = await runHeadlessLogin();

      await reply(message, `Open this link to authenticate:\n\n${url}\n\nAfter signing in, you'll see a code. Send it back here.`);

      const channelId = message.channel?.id || message._signalChatId || state?._channelId;

      state._pendingLoginProcess = loginProc;

      function cleanup(reason) {
        if (!state._pendingLoginProcess) return;
        try { state._pendingLoginProcess.kill(); } catch {}
        state._pendingLoginProcess = null;
        clearTimeout(state._pendingLoginTimeout);
        state._pendingLoginTimeout = null;
        setLoginInProgress(false);
        if (reason) {
          const adapter = ctx.signalAdapter;
          if (adapter && channelId) {
            adapter.sendMessage(channelId, reason).catch(() => {});
          }
        }
      }

      loginProc.once('close', () => {
        cleanup('Auth process exited. If you already submitted a code, send !login to check status. Otherwise send !login to try again.');
      });

      state._pendingLoginTimeout = setTimeout(() => {
        cleanup('Login timed out (2min). Send !login to try again.');
      }, 120000);

    } catch (err) {
      setLoginInProgress(false);
      await reply(message, `Login failed: ${err.message}`);
    }
  },
};
