// Generic wizard engine for multi-step Signal/Discord interactions.
// Supports two modes:
//   - Channel-wide (state.wizard): any message in the channel advances the wizard
//   - Per-sender (state.senderWizards[phone]): only that specific sender's replies advance it
//     Used for group-chat onboarding where one person answers while others can still chat.

/**
 * Start a channel-wide wizard (original behaviour — used for DM onboarding).
 */
async function startWizard(state, message, def) {
  state.wizard = _makeWiz(def);
  await _sendStep(state.wizard, message);
}

/**
 * Start a wizard that only a specific sender can advance.
 * Used by !onboard in group chats.
 * @param {string} targetSenderId - phone number (or Discord user ID) of the person being onboarded
 */
async function startSenderWizard(state, message, def, targetSenderId) {
  if (!state.senderWizards) state.senderWizards = {};
  state.senderWizards[targetSenderId] = _makeWiz(def);
  await _sendStep(state.senderWizards[targetSenderId], message);
}

function _makeWiz(def) {
  return {
    type: def.type,
    step: 0,
    data: { ...(def.initialData || {}) },
    steps: def.steps,
    onComplete: def.onComplete,
    onCancel: def.onCancel, // optional: called with partial data on early exit
    silent: !!def.silent,
  };
}

/**
 * Handle an incoming message when a wizard is active.
 * Checks per-sender wizard first, then channel-wide wizard.
 * @returns {boolean} true if the message was consumed by the wizard
 */
async function handleWizardMessage(state, message) {
  const senderId = message._signalSenderId || message.author?.id;

  // Per-sender wizard (group onboarding)
  if (senderId && state.senderWizards && state.senderWizards[senderId]) {
    const wiz = state.senderWizards[senderId];
    return _processStep(wiz, message, state, () => {
      delete state.senderWizards[senderId];
    });
  }

  // Channel-wide wizard (DM onboarding, etc.)
  if (!state.wizard) return false;
  return _processStep(state.wizard, message, state, () => {
    state.wizard = null;
  });
}

/**
 * Cancel any active wizard for the current sender (or channel-wide).
 */
async function cancelWizard(state, message, { silent = false } = {}) {
  const senderId = message._signalSenderId || message.author?.id;

  // Best-effort partial-state save hook. Runs BEFORE the wizard is
  // deleted so onCancel can see wiz.data in its final collected shape.
  // Errors are logged, not thrown — we never want cancel to fail.
  const flushOnCancel = async (wiz) => {
    if (!wiz || typeof wiz.onCancel !== 'function') return;
    try {
      await wiz.onCancel({ ...wiz.data }, message, state);
    } catch (err) {
      console.warn(`[wizard] ${wiz.type} onCancel failed: ${err.message}`);
    }
  };

  // Cancel per-sender wizard if there is one for this sender
  if (senderId && state.senderWizards && state.senderWizards[senderId]) {
    const wiz = state.senderWizards[senderId];
    const type = wiz.type;
    await flushOnCancel(wiz);
    delete state.senderWizards[senderId];
    if (!silent) await message.reply(`Cancelled **${type}** setup.`);
    return;
  }

  if (!state.wizard) {
    if (!silent) await message.reply('Nothing to cancel.');
    return;
  }
  const type = state.wizard.type;
  await flushOnCancel(state.wizard);
  state.wizard = null;
  if (!silent) await message.reply(`Cancelled **${type}** wizard.`);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _processStep(wiz, message, state, onDone) {
  const step = wiz.steps[wiz.step];
  if (!step) { onDone(); return false; }

  const input = (message.content || '').trim();
  const value = (input === '' && step.default != null) ? step.default : input;

  // Validate
  if (step.validate) {
    const result = step.validate(value, wiz.data);
    if (result !== true) {
      await message.reply(typeof result === 'string' ? result : 'Invalid input. Try again.');
      return true;
    }
  }

  // Store answer
  wiz.data[step.key] = value;

  // Advance to next applicable step
  wiz.step++;
  while (wiz.step < wiz.steps.length) {
    const next = wiz.steps[wiz.step];
    if (next.condition && !next.condition(wiz.data)) { wiz.step++; continue; }
    break;
  }

  // All steps done
  if (wiz.step >= wiz.steps.length) {
    const data = { ...wiz.data };
    const onComplete = wiz.onComplete;
    onDone();
    if (onComplete) await onComplete(data, message, state);
    return true;
  }

  // Send next prompt
  await _sendStep(wiz, message);
  return true;
}

async function _sendStep(wiz, message) {
  // Skip steps whose conditions aren't met
  while (wiz.step < wiz.steps.length) {
    const step = wiz.steps[wiz.step];
    if (step.condition && !step.condition(wiz.data)) { wiz.step++; continue; }
    break;
  }
  if (wiz.step >= wiz.steps.length) return;

  const step = wiz.steps[wiz.step];
  if (!step.prompt) return;

  const promptText = typeof step.prompt === 'function' ? step.prompt(wiz.data) : step.prompt;
  const silent = wiz.silent || step.silent;
  if (silent) {
    await message.reply(promptText);
  } else {
    const stepNum = _visibleStepNum(wiz);
    const total = _visibleStepCount(wiz);
    await message.reply(`**Step ${stepNum}/${total}:** ${promptText}`);
  }
}

// Legacy alias so old call sites (sendCurrentStep) still work
async function sendCurrentStep(state, message) {
  if (state.wizard) await _sendStep(state.wizard, message);
}

function _visibleStepCount(wiz) {
  return wiz.steps.filter(s => !s.condition || s.condition(wiz.data)).length;
}

function _visibleStepNum(wiz) {
  let num = 0;
  for (let i = 0; i <= wiz.step; i++) {
    const s = wiz.steps[i];
    if (!s.condition || s.condition(wiz.data)) num++;
  }
  return num;
}

module.exports = { startWizard, startSenderWizard, handleWizardMessage, cancelWizard, sendCurrentStep };
