/**
 * Tool-call loop detection.
 *
 * JS port of OpenClaw's tool-loop-detection.ts. Three orthogonal detectors run
 * against a per-session sliding window of recent tool calls and their result
 * hashes. The current Claude CLI bot.js had a much simpler `detectLoop()` that
 * only caught dead-simple repetition; this module catches no-progress polling,
 * ping-pong alternation, and runaway repetition with separate warning vs.
 * critical thresholds plus a global circuit breaker.
 *
 * Detector summary:
 *   - generic_repeat:        same tool+args repeated WARN+ times — warn only
 *   - known_poll_no_progress: BashOutput / poll-style tool with identical
 *                             args AND identical result hash — warn at WARN,
 *                             critical at CRITICAL
 *   - ping_pong:             alternating A→B→A→B with stable outcomes —
 *                             warn at WARN, critical at CRITICAL
 *   - global_circuit_breaker: any tool repeated GLOBAL+ times with identical
 *                             no-progress outcomes — always critical
 *
 * Usage from bot.js:
 *   const ld = require('./loop-detection');
 *   // Per channel, store ld.createState() somewhere persistent for the run
 *   // (e.g. channelState.progress.loopState).
 *
 *   // On every tool_use event from the CLI:
 *   ld.recordToolCall(state, toolName, params, toolUseId);
 *   const verdict = ld.detectToolCallLoop(state, toolName, params);
 *   if (verdict.stuck && verdict.level === 'critical') {
 *     // kill the child, message the channel
 *   } else if (verdict.stuck) {
 *     // warn-only
 *   }
 *
 *   // On every tool_result event:
 *   ld.recordToolCallOutcome(state, { toolName, toolParams, toolCallId, result, error });
 */

const crypto = require('node:crypto');

// ── Defaults (overridable per call via opts) ─────────────────────────────────
const DEFAULTS = {
  enabled: true,
  historySize: 30,
  warningThreshold: 10,
  criticalThreshold: 20,
  globalCircuitBreakerThreshold: 30,
  detectors: {
    genericRepeat: true,
    knownPollNoProgress: true,
    pingPong: true,
  },
};

// Tool names whose calls are treated as "polling" — repeated identical calls
// with identical results almost always indicate a stuck poll loop. Add new
// names here as you discover them in the wild.
const POLL_TOOL_NAMES = new Set([
  'BashOutput',         // Claude Code: read background bash output
]);

function resolveOpts(overrides) {
  const o = overrides || {};
  const detectors = o.detectors || {};
  return {
    enabled: o.enabled ?? DEFAULTS.enabled,
    historySize: posInt(o.historySize, DEFAULTS.historySize),
    warningThreshold: posInt(o.warningThreshold, DEFAULTS.warningThreshold),
    criticalThreshold: posInt(o.criticalThreshold, DEFAULTS.criticalThreshold),
    globalCircuitBreakerThreshold: posInt(o.globalCircuitBreakerThreshold, DEFAULTS.globalCircuitBreakerThreshold),
    detectors: {
      genericRepeat: detectors.genericRepeat ?? DEFAULTS.detectors.genericRepeat,
      knownPollNoProgress: detectors.knownPollNoProgress ?? DEFAULTS.detectors.knownPollNoProgress,
      pingPong: detectors.pingPong ?? DEFAULTS.detectors.pingPong,
    },
  };
}

function posInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

// ── Stable serialization & hashing ───────────────────────────────────────────
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function digestStable(value) {
  let serialized;
  try {
    serialized = stableStringify(value);
  } catch {
    serialized = String(value);
  }
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function hashToolCall(toolName, params) {
  return `${toolName}:${digestStable(params)}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Hash a tool RESULT for no-progress comparison. Two results that hash to the
// same value are treated as "no progress was made between these calls". For
// most tools we hash the entire result; for known polling tools we extract a
// stability subset (status + exit code + text) so transient diffs like
// timestamps don't defeat detection.
function hashToolOutcome(toolName, params, result, error) {
  if (error !== undefined) {
    return `error:${digestStable(formatErrorForHash(error))}`;
  }
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'string') return digestStable(result);
  if (!isPlainObject(result)) return digestStable(result);

  // For Claude CLI tool_result blocks the shape is { content: string|array, ... }.
  // Reduce to the textual content only — that's what actually represents
  // "what the tool reported". Drop ids/timestamps that vary between calls.
  const text = extractTextContent(result);
  return digestStable({ text });
}

function formatErrorForHash(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  return stableStringify(error);
}

function extractTextContent(result) {
  if (typeof result === 'string') return result;
  if (!isPlainObject(result)) return '';
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .filter(c => isPlainObject(c) && typeof c.text === 'string')
      .map(c => c.text)
      .join('\n')
      .trim();
  }
  if (typeof result.text === 'string') return result.text;
  return '';
}

function isKnownPollToolCall(toolName /*, params */) {
  return POLL_TOOL_NAMES.has(toolName);
}

// ── Streaks ──────────────────────────────────────────────────────────────────
// Walk back through history looking at calls with identical (toolName, argsHash).
// If consecutive matches all share the same resultHash, that's "no progress".
function getNoProgressStreak(history, toolName, argsHash) {
  let streak = 0;
  let latestResultHash;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const rec = history[i];
    if (!rec || rec.toolName !== toolName || rec.argsHash !== argsHash) continue;
    if (typeof rec.resultHash !== 'string' || !rec.resultHash) continue;
    if (!latestResultHash) {
      latestResultHash = rec.resultHash;
      streak = 1;
      continue;
    }
    if (rec.resultHash !== latestResultHash) break;
    streak += 1;
  }
  return { count: streak, latestResultHash };
}

// Look for the A→B→A→B alternating pattern at the tail of history. Returns
// the count of alternating calls + whether we have stable-outcome evidence.
function getPingPongStreak(history, currentSignature) {
  const last = history[history.length - 1];
  if (!last) return { count: 0, noProgressEvidence: false };

  let otherSignature;
  let otherToolName;
  for (let i = history.length - 2; i >= 0; i -= 1) {
    const call = history[i];
    if (!call) continue;
    if (call.argsHash !== last.argsHash) {
      otherSignature = call.argsHash;
      otherToolName = call.toolName;
      break;
    }
  }
  if (!otherSignature || !otherToolName) return { count: 0, noProgressEvidence: false };

  // Walk backwards counting how many calls alternate cleanly
  let alternatingTailCount = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const call = history[i];
    if (!call) continue;
    const expected = alternatingTailCount % 2 === 0 ? last.argsHash : otherSignature;
    if (call.argsHash !== expected) break;
    alternatingTailCount += 1;
  }
  if (alternatingTailCount < 2) return { count: 0, noProgressEvidence: false };

  // The CURRENT call (the one we're checking, not yet in history) must
  // continue the alternation — i.e. match `otherSignature` (the partner of
  // the most recent call).
  if (currentSignature !== otherSignature) return { count: 0, noProgressEvidence: false };

  // Stable-outcome check: BOTH sides of the ping-pong should be returning
  // identical results. If either side's results vary, the agent might
  // actually be making progress.
  const tailStart = Math.max(0, history.length - alternatingTailCount);
  let firstHashA;
  let firstHashB;
  let noProgressEvidence = true;
  for (let i = tailStart; i < history.length; i += 1) {
    const call = history[i];
    if (!call) continue;
    if (!call.resultHash) { noProgressEvidence = false; break; }
    if (call.argsHash === last.argsHash) {
      if (!firstHashA) firstHashA = call.resultHash;
      else if (firstHashA !== call.resultHash) { noProgressEvidence = false; break; }
      continue;
    }
    if (call.argsHash === otherSignature) {
      if (!firstHashB) firstHashB = call.resultHash;
      else if (firstHashB !== call.resultHash) { noProgressEvidence = false; break; }
      continue;
    }
    noProgressEvidence = false;
    break;
  }
  if (!firstHashA || !firstHashB) noProgressEvidence = false;

  return {
    count: alternatingTailCount + 1,
    pairedToolName: last.toolName,
    pairedSignature: last.argsHash,
    noProgressEvidence,
  };
}

function canonicalPairKey(a, b) {
  return [a, b].sort().join('|');
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a fresh per-session state object. Attach this to your channel state
 * for the duration of one Claude run.
 */
function createState() {
  return {
    toolCallHistory: [], // [{ toolName, argsHash, toolCallId, resultHash, timestamp }]
  };
}

/**
 * Record a tool_use event in the sliding window. Call this from the assistant
 * tool_use stream-json handler BEFORE running the loop check.
 */
function recordToolCall(state, toolName, params, toolCallId, opts) {
  const config = resolveOpts(opts);
  if (!state) return;
  if (!state.toolCallHistory) state.toolCallHistory = [];

  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    toolCallId,
    timestamp: Date.now(),
  });

  if (state.toolCallHistory.length > config.historySize) {
    state.toolCallHistory.splice(0, state.toolCallHistory.length - config.historySize);
  }
}

/**
 * Record the OUTCOME (result or error) of a tool call. Match by toolCallId
 * if available, falling back to most-recent matching (toolName, argsHash).
 */
function recordToolCallOutcome(state, { toolName, toolParams, toolCallId, result, error, opts } = {}) {
  if (!state) return;
  const config = resolveOpts(opts);
  const resultHash = hashToolOutcome(toolName, toolParams, result, error);
  if (!resultHash) return;

  if (!state.toolCallHistory) state.toolCallHistory = [];
  const argsHash = hashToolCall(toolName, toolParams);

  let matched = false;
  for (let i = state.toolCallHistory.length - 1; i >= 0; i -= 1) {
    const call = state.toolCallHistory[i];
    if (!call) continue;
    if (toolCallId && call.toolCallId !== toolCallId) continue;
    if (call.toolName !== toolName || call.argsHash !== argsHash) continue;
    if (call.resultHash !== undefined) continue;
    call.resultHash = resultHash;
    matched = true;
    break;
  }
  if (!matched) {
    state.toolCallHistory.push({
      toolName,
      argsHash,
      toolCallId,
      resultHash,
      timestamp: Date.now(),
    });
  }
  if (state.toolCallHistory.length > config.historySize) {
    state.toolCallHistory.splice(0, state.toolCallHistory.length - config.historySize);
  }
}

/**
 * Convenience wrapper for the Claude CLI stream-json case where the
 * tool_result event only carries the tool_use_id and the raw result content.
 * Looks up the matching tool_use entry by id and stamps its resultHash.
 *
 * Returns true if a matching call was found and updated.
 */
function recordOutcomeById(state, toolCallId, result, error) {
  if (!state || !toolCallId) return false;
  if (!state.toolCallHistory) return false;

  // Hash the result text only (we don't need toolName-specific hashing here
  // because we're looking up by id, not by content match).
  let resultHash;
  if (error !== undefined) {
    resultHash = `error:${digestStable(formatErrorForHash(error))}`;
  } else if (result !== undefined && result !== null) {
    resultHash = digestStable({ text: extractTextContent(result) });
  } else {
    return false;
  }

  for (let i = state.toolCallHistory.length - 1; i >= 0; i -= 1) {
    const call = state.toolCallHistory[i];
    if (!call || call.toolCallId !== toolCallId) continue;
    if (call.resultHash !== undefined) return false; // already stamped
    call.resultHash = resultHash;
    return true;
  }
  return false;
}

/**
 * Run all detectors against the current call. Returns:
 *   { stuck: false } — no loop detected
 *   { stuck: true, level: 'warning'|'critical', detector, count, message, ... }
 */
function detectToolCallLoop(state, toolName, params, opts) {
  const config = resolveOpts(opts);
  if (!config.enabled) return { stuck: false };
  if (!state || !state.toolCallHistory) return { stuck: false };

  const history = state.toolCallHistory;
  const currentHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(history, toolName, currentHash);
  const noProgressStreak = noProgress.count;
  const knownPollTool = isKnownPollToolCall(toolName, params);
  const pingPong = getPingPongStreak(history, currentHash);

  // Global circuit breaker — applies to ANY tool, ALWAYS critical
  if (noProgressStreak >= config.globalCircuitBreakerThreshold) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgressStreak,
      message: `CRITICAL: ${toolName} has repeated identical no-progress outcomes ${noProgressStreak} times. Session blocked by global circuit breaker.`,
      warningKey: `global:${toolName}:${currentHash}:${noProgress.latestResultHash || 'none'}`,
    };
  }

  // Known polling tool with stuck output — critical
  if (knownPollTool && config.detectors.knownPollNoProgress && noProgressStreak >= config.criticalThreshold) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'known_poll_no_progress',
      count: noProgressStreak,
      message: `CRITICAL: ${toolName} called ${noProgressStreak} times with identical args and no progress. Stuck poll loop — session blocked.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash || 'none'}`,
    };
  }

  // Known polling tool — warning
  if (knownPollTool && config.detectors.knownPollNoProgress && noProgressStreak >= config.warningThreshold) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'known_poll_no_progress',
      count: noProgressStreak,
      message: `WARNING: ${toolName} called ${noProgressStreak} times with identical args and no progress. Stop polling and either wait longer or report failure.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash || 'none'}`,
    };
  }

  // Ping-pong critical
  const pingPongWarningKey = pingPong.pairedSignature
    ? `pingpong:${canonicalPairKey(currentHash, pingPong.pairedSignature)}`
    : `pingpong:${toolName}:${currentHash}`;

  if (config.detectors.pingPong && pingPong.count >= config.criticalThreshold && pingPong.noProgressEvidence) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong.count,
      message: `CRITICAL: alternating tool-call ping-pong (${pingPong.count} consecutive) with no progress. Session blocked.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: pingPongWarningKey,
    };
  }

  // Ping-pong warning
  if (config.detectors.pingPong && pingPong.count >= config.warningThreshold) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong.count,
      message: `WARNING: alternating tool-call ping-pong pattern (${pingPong.count} consecutive). Stop retrying.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: pingPongWarningKey,
    };
  }

  // Generic repeat — warn-only, count ALL recent matches not just streak
  if (!knownPollTool && config.detectors.genericRepeat) {
    let recentCount = 0;
    for (const h of history) {
      if (h.toolName === toolName && h.argsHash === currentHash) recentCount += 1;
    }
    if (recentCount >= config.warningThreshold) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'generic_repeat',
        count: recentCount,
        message: `WARNING: ${toolName} called ${recentCount} times with identical args. If not making progress, stop and report failure.`,
        warningKey: `generic:${toolName}:${currentHash}`,
      };
    }
  }

  return { stuck: false };
}

/**
 * Stats helper for !btw / !status display.
 */
function getStats(state) {
  if (!state || !state.toolCallHistory) return { totalCalls: 0, uniquePatterns: 0, mostFrequent: null };
  const patterns = new Map();
  for (const call of state.toolCallHistory) {
    const existing = patterns.get(call.argsHash);
    if (existing) existing.count += 1;
    else patterns.set(call.argsHash, { toolName: call.toolName, count: 1 });
  }
  let mostFrequent = null;
  for (const p of patterns.values()) {
    if (!mostFrequent || p.count > mostFrequent.count) mostFrequent = p;
  }
  return {
    totalCalls: state.toolCallHistory.length,
    uniquePatterns: patterns.size,
    mostFrequent,
  };
}

module.exports = {
  createState,
  recordToolCall,
  recordToolCallOutcome,
  recordOutcomeById,
  detectToolCallLoop,
  getStats,
  // Exposed for tests
  hashToolCall,
  hashToolOutcome,
  DEFAULTS,
};
