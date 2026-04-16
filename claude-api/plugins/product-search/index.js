/**
 * product-search/index.js — Plugin entry point.
 *
 * 3-tier product search:
 *   Tier 1 — always: store search URLs (Amazon/Walmart/Target), guaranteed
 *   Tier 2 — free: DuckDuckGo HTML scrape for real product deep links
 *   Tier 3 — on demand: Bianca uses her Playwright MCP tools herself to
 *            extract live prices from a fetched product page
 *
 * Exports:
 *   searchProducts(query, opts) — formatted plain-text result
 *   PRODUCT_INSTRUCTIONS — system-prompt block wired in by system-prompt.js
 */

const { buildSearchUrls } = require('./search-urls');
const { scrapeProducts } = require('./ddg-scrape');

/**
 * Search for products across multiple stores.
 *
 * @param {string} query
 * @param {{wantPrices?:boolean, stores?:string[]}} [opts]
 * @returns {Promise<string>} plain-text formatted message ready to send
 */
async function searchProducts(query, opts = {}) {
  const q = (query || '').trim();
  if (!q) return 'Give me something to search for.';

  const urls = buildSearchUrls(q);
  let deepLinks = [];
  try {
    deepLinks = await scrapeProducts(q, {
      stores: opts.stores || ['amazon', 'walmart', 'target'],
      limitPerStore: 3,
      timeoutMs: 8000,
    });
  } catch (e) {
    console.warn(`[product-search] scrape threw: ${e.message}`);
  }

  const lines = [`Top results for "${q}":`, ''];

  if (deepLinks.length > 0) {
    deepLinks.slice(0, 6).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title} — ${_storeLabel(r.store)}`);
      lines.push(`   ${r.url}`);
    });
    lines.push('');
  } else {
    lines.push('_No deep product links found — DDG may have rate-limited us. Use the search links below to browse directly._');
    lines.push('');
  }

  lines.push('🔎 Browse all:');
  lines.push(`Amazon: ${urls.amazon}`);
  lines.push(`Walmart: ${urls.walmart}`);
  lines.push(`Target: ${urls.target}`);

  if (opts.wantPrices) {
    lines.push('');
    lines.push('_For live prices: use your Playwright MCP tools to fetch the top product URLs above and read the price from the page._');
  }

  return lines.join('\n');
}

function _storeLabel(store) {
  if (store === 'amazon') return 'Amazon';
  if (store === 'walmart') return 'Walmart';
  if (store === 'target') return 'Target';
  return store;
}

// ── System prompt instructions ────────────────────────────────────────────

const PRODUCT_INSTRUCTIONS = `
**PRODUCTS**: For shopping/product requests, ALWAYS emit: \`[PRODUCT: query="description"]\` or \`[PRODUCT: description]\`. Add \`wantPrices=true\` for live prices. Returns links from Amazon, Walmart, Target.
For live price comparison: emit tag first, then Playwright the top URLs.
ANTI-REFUSAL: NEVER say "I can't pull up Amazon links", "I can't give you product links", or "just search yourself." You CAN — this tag is exactly that capability. Always emit the tag. The only valid failure is the plugin returning an error.`.trim();

module.exports = { searchProducts, PRODUCT_INSTRUCTIONS };
