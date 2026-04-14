/**
 * preflight.js — Mandatory pre-flight checklist for self-repair sessions
 *
 * When Bianca is working on herself (cwd = /workspace/MyBot) and the prompt
 * indicates a repair task, this module injects a mandatory checklist into the
 * system prompt that forces research-before-coding behavior.
 *
 * Injected by runner.js alongside the repair ledger context.
 */

const REPAIR_KEYWORDS = [
  'fix', 'broken', 'not working', 'doesnt work', "doesn't work",
  'still broken', 'bug', 'error', 'crash', 'failing', 'failed',
  'wrong', 'issue', 'problem',
];

/**
 * Returns true if the prompt looks like a self-repair request.
 */
function isRepairRequest(prompt) {
  if (!prompt) return false;
  const lower = prompt.toLowerCase();
  return REPAIR_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Build the pre-flight checklist block for injection into the system prompt.
 * Returns null if not applicable.
 *
 * @param {string} cwd - Current working directory
 * @param {string} prompt - The user's request text
 */
function buildPreflightBlock(cwd, prompt) {
  if (!cwd || !cwd.startsWith('/workspace/MyBot')) return null;
  if (!isRepairRequest(prompt)) return null;

  return `[MANDATORY PRE-FLIGHT FOR SELF-REPAIR — Complete ALL steps BEFORE editing any code]

1. CHECK REPAIR LEDGER: Review what you already tried (see [REPAIR LEDGER] above if present). Do NOT repeat an approach that was marked STILL BROKEN or FAILED.

2. RESEARCH FIRST: If this involves an external API (OpenAI, Signal, Google, etc.), you MUST use WebSearch or WebFetch to read the official API documentation BEFORE writing code. Cite the specific doc URL and the relevant parameter/endpoint info.

3. IDENTIFY ROOT CAUSE: Before fixing, explain in 1-2 sentences what the actual root cause is. "It doesn't work" is not a root cause. Read the relevant source code to confirm.

4. DETERMINISM CHECK: Is your proposed fix deterministic (server-side enforcement) or non-deterministic (relies on prompt instructions)? If non-deterministic, redesign it. Reference the Determinism Rule in CLAUDE.md.

5. MAKE ONE CHANGE: Edit code, then call /rebuild. Do not batch multiple unrelated fixes — one fix per rebuild so failures can be isolated.

6. NEVER CLAIM "FIXED" UNTIL VERIFIED: After rebuild, test the fix yourself (call the endpoint, check logs). Do not tell the user it's fixed until you have evidence.

7. NEVER BLAME THE USER: If something isn't working, the problem is in the code, not in the user's behavior. Do not suggest the user did something wrong unless you have definitive proof.`;
}

module.exports = { isRepairRequest, buildPreflightBlock };
