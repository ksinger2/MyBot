const { getPendingItems, updateItem } = require('./queue-storage');

let running = false;

// Resolve a queue item's destination as a Signal chatId (no `signal:` prefix).
// item.channelId may be a bare phone/chatId or `signal:<chatId>`.
function _resolveSignalChatId(item) {
  const cid = item?.channelId || '';
  if (typeof cid !== 'string' || !cid) return null;
  return cid.replace(/^signal:/, '');
}

async function processNextItem() {
  if (running) return;

  const pending = getPendingItems();
  if (pending.length === 0) return;

  const item = pending[0];
  running = true;

  console.log(`[queue-runner] Starting item #${item.id}: "${item.prompt.substring(0, 80)}"`);
  updateItem(item.id, { status: 'running', startedAt: new Date().toISOString() });

  const { signalAdapter } = require('./bot');
  const chatId = _resolveSignalChatId(item);
  const canSend = signalAdapter && signalAdapter.ready && chatId;
  const send = (text) => canSend
    ? signalAdapter.sendMessage(chatId, text).catch(() => {})
    : Promise.resolve();

  await send(`Starting background task #${item.id}: "${item.prompt.substring(0, 80)}"`);

  const typingInterval = canSend
    ? setInterval(() => signalAdapter.sendTyping(chatId).catch(() => {}), 8000)
    : null;

  try {
    const { runClaudeWithContinuation, getPersonalityFile, freshProgress, sendLongMessage } = require('./bot');

    const transientState = {
      sessionId: null,
      personality: item.personality,
      identity: item.identity,
      cwd: item.cwd,
      process: null,
      busy: true,
      startedAt: Date.now(),
      progress: freshProgress(),
      queue: [],
    };

    const personalityFile = getPersonalityFile(item.personality);

    // Build a no-op channel proxy so the stall detector and error handlers
    // don't crash on null.send(). If we can reach Signal, route messages there.
    const noopProxy = {
      send: (text) => send(text),
      setGroupChat: () => {},
      setOwnerDm: () => {},
    };

    const result = await runClaudeWithContinuation(item.prompt, {
      sessionId: null,
      personalityFile,
      identity: item.identity,
      cwd: item.cwd,
      channelState: transientState,
      channelProxy: noopProxy,
    }, noopProxy);

    const summary = result.text
      ? result.text.substring(0, 200) + (result.text.length > 200 ? '...' : '')
      : '(no output)';

    updateItem(item.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      resultSummary: summary,
    });

    if (canSend && result.text && !result.stopped) {
      const fakeMsg = { _signalChatId: chatId, channel: { id: item.channelId } };
      await sendLongMessage(fakeMsg, result.text, item.cwd);

      const parts = [];
      if (result.numTurns) parts.push(`${result.numTurns} turns`);
      if (result.cost) parts.push(`$${result.cost.toFixed(4)}`);
      if (parts.length) {
        await send(`— Background task #${item.id} complete: ${parts.join(' · ')} —`);
      }
    }

    console.log(`[queue-runner] Item #${item.id} completed`);
  } catch (err) {
    console.error(`[queue-runner] Item #${item.id} failed:`, err.message);
    updateItem(item.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: err.message.substring(0, 300),
    });
    await send(`Background task #${item.id} failed: ${err.message.substring(0, 200)}`);
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    running = false;
    // Drain pattern — immediately process next item if available
    setImmediate(() => processNextItem());
  }
}

function startQueueRunner() {
  console.log('[queue-runner] Started — polling every 30s');

  // Also recover any items stuck in 'running' state from a previous crash
  const { getQueue } = require('./queue-storage');
  const queue = getQueue();
  let recovered = 0;
  for (const item of queue) {
    if (item.status === 'running') {
      updateItem(item.id, { status: 'pending', startedAt: null });
      recovered++;
    }
  }
  if (recovered > 0) {
    console.log(`[queue-runner] Recovered ${recovered} stuck item(s) back to pending`);
  }

  // Poll every 30s
  setInterval(() => processNextItem(), 30000).unref();
  // Also try immediately on startup
  setTimeout(() => processNextItem(), 5000).unref();
}

module.exports = { startQueueRunner, processNextItem };
