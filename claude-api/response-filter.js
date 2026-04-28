// Filters out "no-response" sentinel phrases the model sometimes emits as
// literal text (e.g. "No response requested", "(no response needed)").
// These leak through despite prompt-level instructions, so per the
// Determinism Rule we strip them at the send-sink instead of relying on the
// model to behave.

const NO_RESPONSE_RE = /^\s*[\(\[]?\s*no\s+response\s*(requested|needed|required|necessary)?\s*\.?\s*[\)\]]?\s*$/i;

function isNoResponseSentinel(text) {
  if (!text) return false;
  return NO_RESPONSE_RE.test(text.trim());
}

// Strip the sentinel from arbitrary text. If the text was *only* the
// sentinel, returns ''. Otherwise removes the line and returns the rest.
function stripNoResponse(text) {
  if (!text) return text;
  if (isNoResponseSentinel(text)) return '';
  return text
    .split('\n')
    .filter(line => !isNoResponseSentinel(line))
    .join('\n')
    .trim();
}

module.exports = { isNoResponseSentinel, stripNoResponse };
