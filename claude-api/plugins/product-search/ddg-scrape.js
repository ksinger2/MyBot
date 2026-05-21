/**
 * product-search/ddg-scrape.js — Tier 2: HTML search scraper.
 *
 * Despite the filename (kept for backwards compat with imports), this
 * module now tries Brave Search first and falls back to DuckDuckGo.
 * Reason: DDG aggressively throttles repeat requests from the same IP
 * (HTTP 202 "please wait" interstitial), while Brave Search serves full
 * SSR HTML with stable class names and tolerates higher query volume.
 *
 * Both backends return the same shape:
 *   [ { store, title, url, snippet } ]
 *
 * Filters out ad slots and non-product URLs (per-store signature regex).
 */

const MOZILLA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Per-store product-page URL signatures — a result URL must match one of
// these to be kept. Drops search pages, listing pages, ad redirects, etc.
const STORE_URL_PATTERNS = {
  amazon:  /^https?:\/\/(www\.)?amazon\.com\/[^?\s"]*\/dp\/[A-Z0-9]+/i,
  walmart: /^https?:\/\/(www\.)?walmart\.com\/ip\/[^?\s"]+/i,
  target:  /^https?:\/\/(www\.)?target\.com\/p\/[^?\s"]+/i,
};

// Canonicalize store URLs to their shortest permanent form.
// Scraper URLs include title slugs that break when products are renamed/delisted.
// Amazon: /Whatever-Title/dp/B07ZQ3LGF5/ref=sr... → /dp/B07ZQ3LGF5
// Walmart: /ip/Product-Name/123456789?sp_cid=... → /ip/123456789
// Target: /p/Product-Name/-/A-12345678#lnk=... → /p/-/A-12345678
function _canonicalizeUrl(url, store) {
  try {
    if (store === 'amazon') {
      const m = url.match(/\/dp\/([A-Z0-9]{10})/i);
      if (m) return `https://www.amazon.com/dp/${m[1]}`;
    } else if (store === 'walmart') {
      const m = url.match(/\/ip\/(?:[^/]+\/)?(\d{5,15})/);
      if (m) return `https://www.walmart.com/ip/${m[1]}`;
    } else if (store === 'target') {
      const m = url.match(/(A-\d{6,12})/);
      if (m) return `https://www.target.com/p/-/${m[1]}`;
    }
  } catch {}
  return url;
}

function _cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Brave Search HTML parser (primary) ────────────────────────────────────

/**
 * Parse search.brave.com HTML into [{store,title,url,snippet}] for a
 * given store. Brave's SSR HTML structure (svelte-based, hash-suffixed
 * class names) is matched by stable substrings: `result-wrapper` for the
 * outer block, the `title="..."` attribute for the clean product name,
 * the first `href="https://STORE.com/..."` for the URL, and the inner
 * `generic-snippet` content for the description.
 */
function _parseBraveHtml(html, store) {
  const pattern = STORE_URL_PATTERNS[store];
  if (!pattern) return [];

  // Split into result blocks by the outer result wrapper class
  const blocks = html.split(/class="result-wrapper[^"]*"/i).slice(1);
  const results = [];
  for (const rawBlock of blocks) {
    // Limit block scan to the first ~6KB to stop at the next result
    const block = rawBlock.slice(0, 6000);

    // Find the first store product URL
    const urlMatch = block.match(new RegExp(`https?://(?:www\\.)?${store}\\.com/[^\\s"'<>]{10,300}`, 'i'));
    if (!urlMatch) continue;
    const url = urlMatch[0].replace(/&amp;/g, '&');
    if (!pattern.test(url)) continue;

    // Title: prefer the `title="..."` attribute on the title span (Brave
    // stores the full untruncated title there). Fall back to the result
    // anchor's visible text.
    let title = null;
    const titleAttrMatch = block.match(/title="([^"]{5,400})"[^>]*>[^<]{2,400}</);
    if (titleAttrMatch) {
      title = _cleanText(titleAttrMatch[1]);
    } else {
      const anchorMatch = block.match(/<a[^>]*href="[^"]*"[^>]*>([^<]{5,400})<\/a>/);
      if (anchorMatch) title = _cleanText(anchorMatch[1]);
    }
    if (!title) continue;

    // Strip "Amazon.com: " or "Amazon : " prefix that SERPs sometimes add
    title = title.replace(/^(amazon\.com\s*[:|-]\s*|amazon\s*[:|-]\s*)/i, '');
    // Drop trailing " : Category" clutter
    title = title.replace(/\s*:\s*Electronics\s*$/i, '').slice(0, 140);

    // Snippet: inside the `generic-snippet` / `content` class block
    const snippetMatch = block.match(/class="content[^"]*"[^>]*>([\s\S]{5,400}?)<\/div>/i);
    const snippet = snippetMatch ? _cleanText(snippetMatch[1]).slice(0, 180) : '';

    results.push({ store, title, url: _canonicalizeUrl(url, store), snippet });
  }

  // Dedupe by URL within this store
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

async function _fetchBraveStore(query, store, limit, timeoutMs) {
  const q = `${query} site:${store}.com`;
  const url = `https://search.brave.com/search?q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': MOZILLA_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[product-search] brave ${store} HTTP ${res.status}`);
      return { ok: false, results: [] };
    }
    const html = await res.text();
    const parsed = _parseBraveHtml(html, store);
    return { ok: parsed.length > 0, results: parsed.slice(0, limit) };
  } catch (e) {
    console.warn(`[product-search] brave ${store} error: ${e.message}`);
    return { ok: false, results: [] };
  }
}

// ── DuckDuckGo HTML parser (fallback) ─────────────────────────────────────

function _decodeUddg(href) {
  if (!href) return null;
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (!m) {
    if (/^https?:\/\//i.test(href)) return href;
    return null;
  }
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

function _parseDdgHtml(html, store) {
  const pattern = STORE_URL_PATTERNS[store];
  if (!pattern) return [];
  const blocks = html.split(/<a[^>]*class="result__a"/i).slice(1);
  const results = [];
  for (const rawBlock of blocks) {
    const hrefMatch = rawBlock.match(/href="([^"]+)"/);
    if (!hrefMatch) continue;
    const href = hrefMatch[1].replace(/&amp;/g, '&');
    const url = _decodeUddg(href);
    if (!url || !pattern.test(url)) continue;
    const titleMatch = rawBlock.match(/>([^<]{1,200})<\/a>/);
    const title = titleMatch ? _cleanText(titleMatch[1]) : null;
    const snippetMatch = rawBlock.match(/class="result__snippet"[^>]*>([\s\S]{1,500}?)<\/a>/i)
      || rawBlock.match(/class="result__snippet"[^>]*>([\s\S]{1,500}?)<\/div>/i);
    const snippet = snippetMatch ? _cleanText(snippetMatch[1]).slice(0, 180) : '';
    if (title) results.push({ store, title, url: _canonicalizeUrl(url, store), snippet });
  }
  return results;
}

async function _fetchDdgStore(query, store, limit, timeoutMs) {
  const q = `${query} site:${store}.com`;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': MOZILLA_UA, 'Accept': 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // DDG returns HTTP 202 with a "please wait" interstitial when it's
    // throttling the client IP — treat 202 as a failure so we fall back
    // to the next store / the other backend cleanly.
    if (res.status === 202 || !res.ok) {
      console.warn(`[product-search] ddg ${store} HTTP ${res.status} (likely throttled)`);
      return { ok: false, results: [] };
    }
    const html = await res.text();
    const parsed = _parseDdgHtml(html, store);
    return { ok: parsed.length > 0, results: parsed.slice(0, limit) };
  } catch (e) {
    console.warn(`[product-search] ddg ${store} error: ${e.message}`);
    return { ok: false, results: [] };
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Scrape product results across multiple stores in parallel.
 * Tries Brave Search first (less throttled, richer SSR HTML), falls back
 * to DuckDuckGo per-store if Brave returns nothing.
 *
 * @param {string} query
 * @param {{stores?:string[], limitPerStore?:number, timeoutMs?:number}} opts
 * @returns {Promise<Array<{store,title,url,snippet}>>}
 */
async function scrapeProducts(query, opts = {}) {
  const stores = opts.stores || ['amazon', 'walmart', 'target'];
  const limitPerStore = opts.limitPerStore || 3;
  const timeoutMs = opts.timeoutMs || 8000;

  const perStore = await Promise.all(stores.map(async store => {
    const brave = await _fetchBraveStore(query, store, limitPerStore, timeoutMs);
    if (brave.ok) return brave.results;
    // Brave returned nothing — retry with DDG
    const ddg = await _fetchDdgStore(query, store, limitPerStore, timeoutMs);
    return ddg.results;
  }));

  // Interleave + dedupe across stores so the final list isn't all-Amazon
  // then all-Walmart. First Amazon, first Walmart, first Target, second...
  const seen = new Set();
  const interleaved = [];
  let idx = 0;
  let added = true;
  while (added) {
    added = false;
    for (const storeResults of perStore) {
      if (idx < storeResults.length) {
        const r = storeResults[idx];
        if (!seen.has(r.url)) {
          seen.add(r.url);
          interleaved.push(r);
        }
        added = true;
      }
    }
    idx++;
  }
  return interleaved;
}

module.exports = { scrapeProducts, _canonicalizeUrl };
