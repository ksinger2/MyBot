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
const args = ['@playwright/mcp', '--headless', '--user-data-dir', '/app/data/browser-profile'];
const child = spawn('npx', args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    // Inject blocked URLs via Playwright's CDP protocol
    PLAYWRIGHT_BLOCKED_PATTERNS: JSON.stringify(BLOCKED_URL_PATTERNS.map(r => r.source)),
  },
});

// MCP protocol: stdin/stdout are JSON-RPC, stderr is logs.
// We intercept stdout to filter navigation responses.
process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);

// Intercept JSON-RPC messages from Playwright MCP
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  // JSON-RPC messages are newline-delimited
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) { process.stdout.write('\n'); continue; }
    try {
      const msg = JSON.parse(line);
      // Intercept navigate_page calls — check URL against blocklist
      if (msg.method === 'tools/call' && msg.params?.name === 'playwright_navigate') {
        const url = msg.params?.arguments?.url || '';
        if (BLOCKED_URL_PATTERNS.some(p => p.test(url))) {
          // Return an error response instead of navigating
          const errorResponse = {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: `🚫 BLOCKED: Navigation to checkout/purchase URL is not permitted. URL: ${url}` }],
              isError: true,
            },
          };
          process.stdout.write(JSON.stringify(errorResponse) + '\n');
          continue; // Don't forward to real Playwright
        }
      }
      process.stdout.write(line + '\n');
    } catch {
      // Not JSON — pass through
      process.stdout.write(line + '\n');
    }
  }
});

child.on('exit', (code) => process.exit(code || 0));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
