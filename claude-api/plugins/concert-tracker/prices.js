/**
 * prices.js — Price display formatter for concert ticket results.
 *
 * Ported from /workspace/ConcertTracker/concert-bot/services/prices.js.
 * Removed all database writes and Discord embed formatting — this version
 * produces plain text suitable for Signal messages.
 *
 * Fee disclosure per source:
 *   StubHub   — includes fees in displayed price
 *   TickPick  — includes fees in displayed price (they advertise no-fee)
 *   Ticketmaster — does NOT include fees (add ~30% mentally)
 *   VividSeats   — does NOT include fees
 *   SeatGeek     — does NOT include fees
 */

// ── Section normalization ─────────────────────────────────────────────────────

function normalizeSection(raw) {
  if (!raw) return 'general';
  let s = raw.trim();

  if (/^(general\s*admission|ga\b|lawn(\s+\w+)?|standing|floor\s*ga|pit\s+general)$/i.test(s))
    return 'ga';
  if (/^(pit|floor|field|vip|balcony|orchestra|mezzanine|loge|club|suite)$/i.test(s))
    return s.toLowerCase();

  const secMatch = s.match(/^(?:Section|Sec\.?)\s+(.+)$/i);
  if (secMatch) {
    const id = secMatch[1].trim().toLowerCase();
    if (/^(row|sec|seat|ticket)$/i.test(id)) return 'general';
    return 'section-' + id;
  }

  if (/^\d+$/.test(s)) return 'section-' + s;

  if (/^(row|sec|section|seat|ticket|view|buy|sold|general|secure|checkout|details?)$/i.test(s))
    return 'general';

  return s.toLowerCase();
}

function sectionDisplayLabel(key) {
  if (key === 'ga') return 'General Admission';
  if (key === 'general') return 'General';
  if (key === 'pit') return 'Pit';
  if (key === 'floor') return 'Floor';
  if (key === 'field') return 'Field';
  if (key === 'vip') return 'VIP';
  if (key === 'balcony') return 'Balcony';
  if (key === 'orchestra') return 'Orchestra';
  if (key === 'mezzanine') return 'Mezzanine';
  if (key.startsWith('section-')) return 'Section ' + key.replace('section-', '').toUpperCase();
  return key.replace(/\b\w/g, c => c.toUpperCase());
}

// ── Fee disclosure labels ─────────────────────────────────────────────────────

const FEE_LABELS = {
  stubhub: 'fees incl.',
  tickpick: 'no fees',
  ticketmaster: 'fees not incl.',
  vividseats: 'fees not incl.',
  seatgeek: 'fees not incl.',
};

const SITE_NAMES = {
  stubhub: 'StubHub',
  tickpick: 'TickPick',
  ticketmaster: 'Ticketmaster',
  vividseats: 'VividSeats',
  seatgeek: 'SeatGeek',
};

// ── Pool and sort all listings ────────────────────────────────────────────────

/**
 * Collect every individual listing from all sources, attach source metadata,
 * sort by price ascending, and return the 10 cheapest.
 */
function poolListings(pricesBySource) {
  const all = [];
  for (const [site, result] of Object.entries(pricesBySource)) {
    if (!result || !result.listings || !result.listings.length) continue;
    for (const listing of result.listings) {
      if (listing.price == null) continue;
      all.push({ ...listing, site });
    }
  }
  all.sort((a, b) => a.price - b.price);
  return all.slice(0, 10);
}

/**
 * Group cheapest-per-section across all sources.
 * Returns { normalizedKey → { label, bestPrice, sources: { site → listing } } }
 */
function groupBySection(pricesBySource) {
  const groups = {};
  for (const [site, result] of Object.entries(pricesBySource)) {
    if (!result || !result.listings || !result.listings.length) continue;
    for (const listing of result.listings) {
      if (listing.price == null) continue;
      const key = normalizeSection(listing.section);
      if (!groups[key]) {
        groups[key] = { label: sectionDisplayLabel(key), bestPrice: Infinity, sources: {} };
      }
      if (!groups[key].sources[site] || listing.price < groups[key].sources[site].price) {
        groups[key].sources[site] = { ...listing, site };
      }
      if (listing.price < groups[key].bestPrice) {
        groups[key].bestPrice = listing.price;
      }
    }
  }
  return groups;
}

// ── Format a price ────────────────────────────────────────────────────────────

function fmt(price) {
  return '$' + Math.round(price).toLocaleString();
}

// ── Main formatter ────────────────────────────────────────────────────────────

/**
 * Format scraped price results as a plain-text Signal message.
 *
 * @param {Object} pricesBySource — { stubhub: result|null, vividseats: result|null, ... }
 *   Each result: { min, max, includesFees, listings: [{ price, section, row, ... }], url }
 * @param {Object} opts
 * @param {string} opts.artist
 * @param {string} opts.venue
 * @param {string} opts.date
 * @param {string} opts.city
 * @returns {string}
 */
function formatPriceResults(pricesBySource, { artist = '', venue = '', date = '', city = '' } = {}) {
  const lines = [];

  // Header
  const headerParts = [artist].filter(Boolean);
  if (venue) headerParts.push(`@ ${venue}`);
  if (city && !venue) headerParts.push(city);
  if (date) headerParts.push(`(${date})`);
  if (headerParts.length) {
    lines.push(`Tickets: ${headerParts.join(' ')}`);
    lines.push('');
  }

  // Source summary — min prices from each site
  const summaryLines = [];
  for (const [site, result] of Object.entries(pricesBySource)) {
    if (!result || result.min == null) continue;
    const name = SITE_NAMES[site] || site;
    const feeLabel = FEE_LABELS[site] || '';
    const minStr = fmt(result.min);
    const maxStr = result.max != null ? ` – ${fmt(result.max)}` : '+';
    summaryLines.push(`  ${name}: ${minStr}${maxStr}${feeLabel ? '  (' + feeLabel + ')' : ''}`);
  }

  if (summaryLines.length === 0) {
    return (lines.join('\n') + '\nNo listings found across any source.').trim();
  }

  lines.push('Price ranges:');
  lines.push(...summaryLines);
  lines.push('');

  // 10 cheapest individual listings
  const cheapest = poolListings(pricesBySource);
  if (cheapest.length > 0) {
    lines.push('10 cheapest listings:');
    for (const l of cheapest) {
      const name = SITE_NAMES[l.site] || l.site;
      const feeLabel = FEE_LABELS[l.site] ? ` (${FEE_LABELS[l.site]})` : '';
      const sectionLabel = l.section ? ` · ${l.section}` : '';
      const rowLabel = l.row ? ` row ${l.row}` : '';
      const qtyLabel = l.quantity != null ? ` · ${l.quantity}x` : '';
      lines.push(`  ${fmt(l.price)}${feeLabel} — ${name}${sectionLabel}${rowLabel}${qtyLabel}`);
    }
    lines.push('');
  }

  // Section breakdown — cheapest per section across all sources
  const groups = groupBySection(pricesBySource);
  const sortedGroups = Object.entries(groups)
    .filter(([, g]) => g.bestPrice < Infinity)
    .sort((a, b) => a[1].bestPrice - b[1].bestPrice);

  if (sortedGroups.length > 0) {
    lines.push('By section (cheapest per section):');
    for (const [, group] of sortedGroups) {
      const sourceParts = Object.entries(group.sources)
        .sort((a, b) => a[1].price - b[1].price)
        .slice(0, 3)
        .map(([site, l]) => `${SITE_NAMES[site] || site} ${fmt(l.price)}`);
      lines.push(`  ${group.label}: ${fmt(group.bestPrice)} (${sourceParts.join(', ')})`);
    }
    lines.push('');
  }

  // Fee disclosure footer
  lines.push('Note: StubHub & TickPick prices include fees. Ticketmaster, VividSeats, SeatGeek add fees at checkout (~20-30%).');

  return lines.join('\n');
}

module.exports = { formatPriceResults, normalizeSection, sectionDisplayLabel, poolListings };
