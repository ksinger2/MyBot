// Generic wizard engine for multi-step Discord interactions

/**
 * Start a wizard on a channel
 * @param {object} state - channel state object
 * @param {object} message - Discord message that triggered the wizard
 * @param {object} def - wizard definition { type, steps, onComplete }
 */
async function startWizard(state, message, def) {
  state.wizard = {
    type: def.type,
    step: 0,
    data: {},
    steps: def.steps,
    onComplete: def.onComplete,
  };

  // Find and send the first applicable step
  await sendCurrentStep(state, message);
}

/**
 * Handle an incoming message when a wizard is active
 * @returns {boolean} true if the message was consumed by the wizard
 */
async function handleWizardMessage(state, message) {
  if (!state.wizard) return false;

  const wiz = state.wizard;
  const step = wiz.steps[wiz.step];
  if (!step) {
    state.wizard = null;
    return false;
  }

  const input = message.content.trim();

  // Use default if empty and default exists
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
    if (next.condition && !next.condition(wiz.data)) {
      wiz.step++;
      continue;
    }
    break;
  }

  // Done?
  if (wiz.step >= wiz.steps.length) {
    const data = { ...wiz.data };
    const onComplete = wiz.onComplete;
    state.wizard = null;
    if (onComplete) await onComplete(data, message, state);
    return true;
  }

  // Send next step prompt
  await sendCurrentStep(state, message);
  return true;
}

/**
 * Cancel an active wizard
 */
async function cancelWizard(state, message) {
  if (!state.wizard) {
    await message.reply('Nothing to cancel.');
    return;
  }
  const type = state.wizard.type;
  state.wizard = null;
  await message.reply(`Cancelled **${type}** wizard.`);
}

/**
 * Send the prompt for the current wizard step
 */
async function sendCurrentStep(state, message) {
  const wiz = state.wizard;
  if (!wiz) return;

  // Skip steps whose conditions are not met
  while (wiz.step < wiz.steps.length) {
    const step = wiz.steps[wiz.step];
    if (step.condition && !step.condition(wiz.data)) {
      wiz.step++;
      continue;
    }
    break;
  }

  if (wiz.step >= wiz.steps.length) return;

  const step = wiz.steps[wiz.step];
  if (step.prompt) {
    const stepNum = getVisibleStepNumber(wiz);
    const totalVisible = getVisibleStepCount(wiz);
    const prefix = `**Step ${stepNum}/${totalVisible}:**`;
    await message.reply(`${prefix} ${step.prompt}`);
  }
}

function getVisibleStepCount(wiz) {
  return wiz.steps.filter(s => !s.condition || s.condition(wiz.data)).length;
}

function getVisibleStepNumber(wiz) {
  let num = 0;
  for (let i = 0; i <= wiz.step; i++) {
    const s = wiz.steps[i];
    if (!s.condition || s.condition(wiz.data)) num++;
  }
  return num;
}

module.exports = { startWizard, handleWizardMessage, cancelWizard };
