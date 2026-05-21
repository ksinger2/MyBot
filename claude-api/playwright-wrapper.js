#!/usr/bin/env node
'use strict';

/**
 * Playwright MCP wrapper — spawns @playwright/mcp with deterministic URL blocking.
 *
 * Blocks checkout/purchase/payment URLs at the browser level so the LLM
 * cannot complete purchases regardless of what instructions it receives.
 * This is the ONLY enforcement layer — the system prompt is UI polish only.
 *
 * Blocked patterns:
 *   amazon.com/gp/buy, /checkout, /place-order
 *   any domain: /checkout, /payment, /purchase, /place-order, /buy/submit
 *
 * Usage in .mcp.json:
 *   { "command": "node", "args": ["/app/playwright-wrapper.js"] }
 */

const { spawn } = require('child_process');

const BLOCKED_URL_PATTERNS = [
  // Amazon-specific checkout paths
  /amazon\.com\/gp\/buy/i,
  /amazon\.com\/gp\/cart\/checkout/i,
  /amazon\.com\/place-order/i,
  /amazon\.com\/gp\/place-order/i,
  // Generic checkout/payment patterns (any site)
  /\/checkout\b/i,
  /\/payment\b/i,
  /\/place.?order/i,
  /\/buy\/submit/i,
  /\/purchase\/confirm/i,
];

// Spawn the real Playwright MCP with all original args
const args = [
  '@playwright/mcp', '--headless',
  '--user-data-dir', '/app/data/browser-profile',
  '--user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  '--viewport-size', '1280,800',
];
const child = spawn('npx', args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    // Inject blocked URLs via Playwright's CDP protocol
    PLAYWRIGHT_BLOCKED_PATTERNS: JSON.stringify(BLOCKED_URL_PATTERNS.map(r => r.source)),
  },
});

// MCP protocol: stdin/stdout are JSON-RPC, stderr is logs.
// Intercept STDIN (requests from Claude → Playwright) to block checkout URLs.
// Previously this intercepted stdout (responses), which never matched because
// tools/call requests only appear on stdin.
child.stderr.pipe(process.stderr);

let inBuffer = '';
process.stdin.on('data', (chunk) => {
  inBuffer += chunk.toString();
  const lines = inBuffer.split('\n');
  inBuffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) { child.stdin.write('\n'); continue; }
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'tools/call') {
        const toolName = msg.params?.name || '';
        const args = msg.params?.arguments || {};

        // Block navigate to checkout/purchase URLs
        if (toolName === 'playwright_navigate') {
          const url = args.url || '';
          if (BLOCKED_URL_PATTERNS.some(p => p.test(url))) {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: `🚫 BLOCKED: Navigation to checkout/purchase URL is not permitted. URL: ${url}` }], isError: true },
            }) + '\n');
            continue;
          }
        }

        // Block JS evaluation that navigates to checkout URLs
        if (toolName === 'playwright_evaluate_script') {
          const script = args.script || args.expression || '';
          if (BLOCKED_URL_PATTERNS.some(p => p.test(script))) {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: '🚫 BLOCKED: Script contains a checkout/purchase URL.' }], isError: true },
            }) + '\n');
            continue;
          }
        }
      }
      child.stdin.write(line + '\n');
    } catch {
      child.stdin.write(line + '\n');
    }
  }
});

// Pass responses from Playwright → Claude unmodified
child.stdout.pipe(process.stdout);

child.on('exit', (code) => process.exit(code || 0));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
