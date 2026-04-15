/**
 * product-search/search-urls.js — Tier 1: deterministic store search URLs.
 *
 * Pure string templates. No network calls, no quota, no failure mode.
 * These always work and always give the user a tap-to-open search page
 * even if the DDG scrape (Tier 2) returns zero deep links.
 */

function buildSearchUrls(query) {
  const q = encodeURIComponent((query || '').trim());
  return {
    amazon:  `https://www.amazon.com/s?k=${q}`,
    walmart: `https://www.walmart.com/search?q=${q}`,
    target:  `https://www.target.com/s?searchTerm=${q}`,
  };
}

module.exports = { buildSearchUrls };
