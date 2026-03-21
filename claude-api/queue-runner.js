const { getPendingItems, updateItem } = require('./queue-storage');

let running = false;
let clientRef = null;

async function processNextItem() {
  if (running) return;

  const pending = getPendingItems();
  if (pending.length === 0) return;

  const item = pending[0];
  running = true;

  console.log(`[queue-runner] Starting item #${item.id}: "${item.prompt.substring(0, 80)}"`);
  updateItem(item.id, { status: 'running', startedAt: new Date().toISOString() });

  let channel;
  try {
    channel = await clientRef.channels.fetch(item.channelId).catch(() => null);
  } catch {}

  if (channel) {
    await channel.send(`*Starting background task **#${item.id}**: "${item.prompt.substring(0, 80)}"*`).catch(() => {});
  }

  const typingInterval = channel
    ? setInterval(() => channel.sendTyping().catch(() => {}), 8000)
    : null;

  try {
    const { runClaudeWithContinuation, getPersonalityFile, freshProgress, sendLongMessage } = require('./bot');

    // Create a transient channel state so we don't conflict with interactive use
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

    const result = await runClaudeWithContinuation(item.prompt, {
      sessionId: null,
      personalityFile,
      identity: item.identity,
      cwd: item.cwd,
      channelState: transientState,
      discordChannel: channel,
    }, channel);

    const summary = result.text
      ? result.text.substring(0, 200) + (result.text.length > 200 ? '...' : '')
      : '(no output)';

    updateItem(item.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      resultSummary: summary,
    });

    if (channel && result.text && !result.stopped) {
      const fakeMsg = { reply: (opts) => channel.send(opts), channel };
      await sendLongMessage(fakeMsg, result.text, item.cwd);

      // Completion stats
      const parts = [];
      if (result.numTurns) parts.push(`${result.numTurns} turns`);
      if (result.cost) parts.push(`$${result.cost.toFixed(4)}`);
      if (parts.length) {
        await channel.send(`*— Background task #${item.id} complete: ${parts.join(' · ')} —*`).catch(() => {});
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
    if (channel) {
      await channel.send(`*Background task **#${item.id}** failed: ${err.message.substring(0, 200)}*`).catch(() => {});
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    running = false;
    // Drain pattern — immediately process next item if available
    setImmediate(() => processNextItem());
  }
}

function startQueueRunner(client) {
  clientRef = client;
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
  setInterval(() => processNextItem(), 30000);
  // Also try immediately on startup
  setTimeout(() => processNextItem(), 5000);
}

module.exports = { startQueueRunner, processNextItem };
