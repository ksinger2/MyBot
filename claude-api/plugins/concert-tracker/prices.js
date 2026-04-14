/**
 * prices.js — Price display formatter for concert ticket results.
 *
 * Fee disclosure per source:
 *   StubHub   — includes fees in displayed price
 *   TickPick  — includes fees in displayed price (they advertise no-fee)
 *   Ticketmaster — does NOT include fees (add ~30% mentally)
 *   VividSeats   — does NOT include fees
 *   SeatGeek     — does NOT include fees
 */

const FEE_LABELS = {
  stubhub: 'fees incl.',
  tickpick: 'no fees',
  ticketmaster: '+fees',
  vividseats: '+fees',
  seatgeek: '+fees',
};

const SITE_NAMES = {
  stubhub: 'StubHub',
  tickpick: 'TickPick',
  ticketmaster: 'Ticketmaster',
  vividseats: 'VividSeats',
  seatgeek: 'SeatGeek',
};

function fmt(price) {
  return '$' + Math.round(price).toLocaleString();
}

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

// ── Main formatter ────────────────────────────────────────────────────────────

/**
 * Format scraped price results as a plain-text Signal message.
 *
 * @param {Object} pricesBySource — { stubhub: result|null, ... }
 *   Each result: { min, max, includesFees, listings, url }
 * @param {Object} opts — { artist, venue, date, city }
 * @param {Object|null} trend — from concert-price-history.getTrend()
 * @returns {string}
 */
function formatPriceResults(pricesBySource, { artist = '', venue = '', date = '', city = '' } = {}, trend = null) {
  const lines = [];

  // Header
  const headerParts = [artist ? `**${artist}**` : ''].filter(Boolean);
  if (venue) headerParts.push(`@ ${venue}`);
  if (city && !venue) headerParts.push(city);
  if (date) headerParts.push(`(${date})`);
  if (headerParts.length) {
    lines.push(`🎵 ${headerParts.join(' ')}`);
    lines.push('');
  }

  // Per-site summary with min, avg, and buy link
  const siteResults = [];
  for (const [site, result] of Object.entries(pricesBySource)) {
    if (!result || result.min == null) continue;
    const name = SITE_NAMES[site] || site;
    const fee = FEE_LABELS[site] || '';

    // Compute average from listings
    let avg = null;
    if (result.listings && result.listings.length > 0) {
      const prices = result.listings.map(l => l.price).filter(p => p != null);
      if (prices.length > 0) avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    }

    // Build buy link (markdown — Signal cleanup will strip long URLs to just title)
    const buyLink = result.url ? `[Buy on ${name}](${result.url})` : name;

    const avgStr = avg != null ? ` / ${fmt(avg)} avg` : '';
    siteResults.push({
      site, name, min: result.min, avg, fee, buyLink,
      line: `- ${name}: ${fmt(result.min)} min${avgStr} (${fee}) — ${buyLink}`,
    });
  }

  if (siteResults.length === 0) {
    return (lines.join('\n') + '\nNo listings found across any source.').trim();
  }

  // Overall min and avg ACROSS all platforms (the key summary line)
  const allMins = siteResults.map(s => s.min).filter(v => v != null);
  const allAvgs = siteResults.map(s => s.avg).filter(v => v != null);
  const overallMin = allMins.length > 0 ? Math.min(...allMins) : null;
  const overallAvg = allAvgs.length > 0 ? Math.round(allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length) : null;
  if (overallMin != null) {
    const avgStr = overallAvg != null ? ` · avg ${fmt(overallAvg)}` : '';
    lines.push(`💰 From ${fmt(overallMin)}${avgStr} across ${siteResults.length} sites`);
    lines.push('');
  }

  // Per-site detail
  lines.push(...siteResults.map(s => s.line));
  lines.push('');

  // Best deal highlight
  // Find cheapest all-in (StubHub/TickPick include fees)
  const allIn = siteResults.filter(s => ['stubhub', 'tickpick'].includes(s.site));
  const presFee = siteResults.filter(s => !['stubhub', 'tickpick'].includes(s.site));
  const bestAllIn = allIn.length > 0 ? allIn.reduce((a, b) => a.min < b.min ? a : b) : null;
  const bestPreFee = presFee.length > 0 ? presFee.reduce((a, b) => a.min < b.min ? a : b) : null;

  const dealParts = [];
  if (bestPreFee) dealParts.push(`${fmt(bestPreFee.min)} on ${bestPreFee.name} (${bestPreFee.fee})`);
  if (bestAllIn) dealParts.push(`${fmt(bestAllIn.min)} on ${bestAllIn.name} (all-in)`);
  if (dealParts.length > 0) {
    lines.push(`💰 Cheapest: ${dealParts.join(' | ')}`);
  }

  // Trend info from price history
  if (trend && trend.message) {
    lines.push(`📊 ${trend.message}`);
  }

  lines.push('');

  // 5 cheapest individual listings with URLs
  const cheapest = poolListings(pricesBySource).slice(0, 5);
  if (cheapest.length > 0) {
    lines.push('Top 5 cheapest listings:');
    for (const l of cheapest) {
      const name = SITE_NAMES[l.site] || l.site;
      const fee = FEE_LABELS[l.site] ? ` (${FEE_LABELS[l.site]})` : '';
      const section = l.section ? ` · ${normalizeSection(l.section) === 'ga' ? 'GA' : l.section}` : '';
      const row = l.row ? ` row ${l.row}` : '';
      const link = l.url ? ` — [View](${l.url})` : '';
      lines.push(`- ${fmt(l.price)}${fee} — ${name}${section}${row}${link}`);
    }
  }

  lines.push('');
  lines.push('_StubHub & TickPick prices include fees. Others add ~20-30% at checkout._');

  return lines.join('\n');
}

module.exports = { formatPriceResults, normalizeSection, sectionDisplayLabel, poolListings };
