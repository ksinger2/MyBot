'use strict';

const FEED_TIMEOUT = 15_000;

const USER_AGENT = 'Mozilla/5.0 (compatible; MyBot/1.0; RSS reader)';

async function fetchFeed(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(FEED_TIMEOUT),
    });
    if (!res.ok) {
      console.warn(`[rss] ${url} returned HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    return parseXml(xml, url);
  } catch (err) {
    console.warn(`[rss] Failed to fetch ${url}: ${err.message}`);
    return [];
  }
}

function parseXml(xml, feedUrl) {
  const items = [];

  // Extract source name from feed URL
  const source = feedUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].replace(/\.\w+$/, '');

  // Try RSS <item> tags first
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of rssItems) {
    const title = extractTag(block, 'title');
    const link = extractLink(block);
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
    if (title && link) {
      items.push({ title: decodeEntities(title), link, pubDate: pubDate ? new Date(pubDate) : null, source });
    }
  }

  // Try Atom <entry> tags if no RSS items found
  if (items.length === 0) {
    const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const block of atomEntries) {
      const title = extractTag(block, 'title');
      const link = extractAtomLink(block);
      const pubDate = extractTag(block, 'published') || extractTag(block, 'updated');
      if (title && link) {
        items.push({ title: decodeEntities(title), link, pubDate: pubDate ? new Date(pubDate) : null, source });
      }
    }
  }

  return items;
}

function extractTag(block, tag) {
  // Handle CDATA: <title><![CDATA[Some title]]></title>
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const cdataMatch = block.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

function extractLink(block) {
  // RSS: <link>url</link>
  const linkTag = extractTag(block, 'link');
  if (linkTag) return linkTag;
  // Fallback: <guid isPermaLink="true">url</guid>
  const guid = extractTag(block, 'guid');
  if (guid && guid.startsWith('http')) return guid;
  return null;
}

function extractAtomLink(block) {
  // Atom: <link href="url" rel="alternate" />
  const m = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
  return m ? m[1] : null;
}

function decodeEntities(str) {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&amp;/g, '&');
}

async function fetchFeeds(feedUrls) {
  const results = await Promise.allSettled(feedUrls.map(url => fetchFeed(url)));
  const allItems = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allItems.push(...r.value);
  }
  return allItems;
}

function filterRecent(items, windowMs) {
  const cutoff = Date.now() - windowMs;
  return items.filter(item => {
    if (!item.pubDate || isNaN(item.pubDate.getTime())) return true; // keep items with no date (could be recent)
    return item.pubDate.getTime() > cutoff;
  });
}

function dedup(items, seenSet) {
  const unseen = [];
  for (const item of items) {
    const key = item.title.substring(0, 80).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (!seenSet.has(key)) {
      unseen.push({ ...item, _dedupKey: key });
    }
  }
  return unseen;
}

function timeAgo(date) {
  if (!date || isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor(diffMs / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ago`;
  if (hours >= 1) return `${hours}h ago`;
  if (mins >= 1) return `${mins}m ago`;
  return 'just now';
}

function formatBullets(items, { header, emoji, maxBullets = 12, nothingMessage = null } = {}) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) + ' PT';
  const headerLine = `**${emoji} ${header}** — ${timeStr}`;

  if (items.length === 0) {
    return nothingMessage || `${headerLine}\nNothing new since last check.`;
  }

  // Sort newest first
  items.sort((a, b) => {
    if (!a.pubDate) return 1;
    if (!b.pubDate) return -1;
    return b.pubDate.getTime() - a.pubDate.getTime();
  });

  const bullets = items.slice(0, maxBullets).map(item => {
    const ago = timeAgo(item.pubDate);
    const agoStr = ago ? ` (${ago})` : '';
    return `• [${capitalize(item.source)}](${item.link}) ${item.title}${agoStr}`;
  });

  return `${headerLine}\n${bullets.join('\n')}`;
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { fetchFeeds, filterRecent, dedup, formatBullets, fetchFeed, parseXml };
