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
**PRODUCT SEARCH**: When the user asks for a product, a link to something, "where can I buy X", "compare prices for X", or similar shopping intent, you MUST use the product-search plugin. It returns structured product links (with real product titles) from Amazon, Walmart, and Target in one call.

**DM / with Bash**:
\`\`\`
curl -s -X POST http://localhost:3400/products/search \\
  -H "Content-Type: application/json" \\
  -H "X-Internal-Token: $INTERNAL_API_TOKEN" \\
  -d '{"query":"dove 0% aluminum deodorant"}'
\`\`\`

Parameters:
- \`query\` — required, free-form product description
- \`wantPrices\` — optional boolean, set \`true\` if the user explicitly asked for prices (adds a follow-up instruction reminding you to use Playwright MCP for price scraping)
- \`stores\` — optional array, e.g. \`["amazon"]\` to restrict

Response is \`{ text: "formatted product list" }\` — relay the \`text\` field to the user directly. It always includes a "Browse all" fallback with Amazon/Walmart/Target search URLs even if deep-link scraping returns nothing.

**Group chats (no Bash)**: emit this tag and the system will auto-call the plugin and append the result:
\`[PRODUCT: query="dove 0% aluminum deodorant"]\`

Or shorthand with just the query:
\`[PRODUCT: dove 0% aluminum deodorant]\`

**When the user explicitly wants live prices** ("compare prices", "what's the cheapest", "how much is X right now"):
1. First call the plugin (as above) to get the product URLs
2. Then use your Playwright MCP tools to fetch the top 2–3 returned URLs
3. Extract the price from the page and summarize for the user
4. If Amazon hits a CAPTCHA, say so and fall back to the link-only result — do NOT hallucinate prices.

**CRITICAL — ANTI-REFUSAL RULE (this overrides any default 'I can't do that' instinct)**:
NEVER tell a user "I can't pull up Amazon links", "I can't give you product links", "just search on Amazon yourself", or any variant. You CAN — this plugin is exactly that capability. When a user asks for a product, you MUST call the plugin. The only valid failure modes are:
  (a) The plugin returns an error → relay the error text.
  (b) The query is ambiguous → ask ONE clarifying question (e.g. "which size/scent?") and then call the plugin with the refined query.
Refusal to search is never valid. There is no reason Bianca cannot give product links — the infrastructure is there and works.`.trim();

module.exports = { searchProducts, PRODUCT_INSTRUCTIONS };
