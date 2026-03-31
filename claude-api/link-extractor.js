/**
 * link-extractor.js
 *
 * Detects social media and location links in Discord messages, pre-fetches
 * metadata (oEmbed, OG tags), classifies content type, and builds action-oriented
 * prompts for Claude CLI.
 */

const PLATFORM_PATTERNS = [
  {
    platform: 'tiktok',
    type: 'social',
    patterns: [
      /https?:\/\/(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/gi,
      /https?:\/\/(?:vm|vt)\.tiktok\.com\/[\w]+/gi,
      /https?:\/\/(?:www\.)?tiktok\.com\/t\/[\w]+/gi,
    ],
  },
  {
    platform: 'instagram',
    type: 'social',
    patterns: [
      /https?:\/\/(?:www\.)?instagram\.com\/p\/[\w-]+\/?/gi,
      /https?:\/\/(?:www\.)?instagram\.com\/reel\/[\w-]+\/?/gi,
    ],
  },
  {
    platform: 'youtube',
    type: 'video',
    patterns: [
      /https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s]+/gi,
      /https?:\/\/youtu\.be\/[\w-]+/gi,
      /https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/gi,
    ],
  },
  {
    platform: 'twitter',
    type: 'social',
    patterns: [
      /https?:\/\/(?:www\.)?twitter\.com\/\w+\/status\/\d+/gi,
      /https?:\/\/x\.com\/\w+\/status\/\d+/gi,
    ],
  },
  {
    platform: 'reddit',
    type: 'social',
    patterns: [
      /https?:\/\/(?:www\.)?reddit\.com\/r\/\w+\/comments\/[\w]+/gi,
    ],
  },
  {
    platform: 'google-maps',
    type: 'location',
    patterns: [
      /https?:\/\/(?:www\.)?google\.com\/maps\/place\/[^\s]+/gi,
      /https?:\/\/maps\.google\.com\/[^\s]+/gi,
      /https?:\/\/goo\.gl\/maps\/[\w]+/gi,
      /https?:\/\/maps\.app\.goo\.gl\/[\w]+/gi,
    ],
  },
  {
    platform: 'yelp',
    type: 'location',
    patterns: [
      /https?:\/\/(?:www\.)?yelp\.com\/biz\/[^\s]+/gi,
    ],
  },
  {
    platform: 'eventbrite',
    type: 'event',
    patterns: [
      /https?:\/\/(?:www\.)?eventbrite\.com\/e\/[^\s]+/gi,
    ],
  },
];

/**
 * Detect supported links in a message.
 */
function detectLinks(messageContent) {
  if (!messageContent || typeof messageContent !== 'string') return [];

  const results = [];
  const seen = new Set();

  for (const { platform, type, patterns } of PLATFORM_PATTERNS) {
    for (const regex of patterns) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(messageContent)) !== null) {
        const url = match[0].replace(/[)>,;]+$/, '');
        if (!seen.has(url)) {
          seen.add(url);
          results.push({ url, type, platform });
        }
      }
    }
  }

  return results;
}

// --- Metadata Pre-fetching ---

/**
 * Follow HTTP redirects for short URLs. Returns canonical URL or original on failure.
 */
async function resolveShortUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
    });
    clearTimeout(timeout);

    const location = res.headers.get('location');
    if (location && location !== url) {
      // Follow one more hop if needed
      if (/^https?:\/\//.test(location)) return location;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Fetch oEmbed data from a provider.
 */
async function fetchOEmbed(oembedUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(oembedUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Extract OG/meta tags from HTML (first 8KB only).
 */
async function fetchOgTags(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    // Read only first 8KB to find <head> meta tags
    const reader = res.body.getReader();
    let html = '';
    while (html.length < 8192) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel().catch(() => {});

    const tags = {};
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) tags.title = titleMatch[1].trim();

    const metaRegex = /<meta\s+(?:property|name)=["'](og:|twitter:)?([^"']+)["']\s+content=["']([^"']*)["']/gi;
    let m;
    while ((m = metaRegex.exec(html)) !== null) {
      const key = (m[1] || '') + m[2];
      tags[key] = m[3];
    }
    // Also match content-first order: <meta content="..." property="og:...">
    const metaRegex2 = /<meta\s+content=["']([^"']*)["']\s+(?:property|name)=["'](og:|twitter:)?([^"']+)["']/gi;
    while ((m = metaRegex2.exec(html)) !== null) {
      const key = (m[2] || '') + m[3];
      if (!tags[key]) tags[key] = m[1];
    }

    return {
      title: tags['og:title'] || tags.title || null,
      description: tags['og:description'] || tags.description || null,
      type: tags['og:type'] || null,
      image: tags['og:image'] || null,
    };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Fetch metadata for a single link. Returns enriched link object.
 */
async function fetchLinkMetadata(link) {
  const result = { ...link, metadata: null, resolvedUrl: link.url, fetchError: null };

  try {
    switch (link.platform) {
      case 'tiktok': {
        // oEmbed works directly with short URLs — no need to resolve first
        const oembed = await fetchOEmbed(`https://www.tiktok.com/oembed?url=${encodeURIComponent(link.url)}`);
        if (oembed) {
          // Also resolve for canonical URL
          const resolved = await resolveShortUrl(link.url);
          result.resolvedUrl = resolved;
          result.metadata = {
            title: oembed.title || null,
            author: oembed.author_name || null,
            authorUrl: oembed.author_url || null,
            thumbnail: oembed.thumbnail_url || null,
          };
        } else {
          result.fetchError = 'oEmbed failed — use WebSearch to look up this TikTok';
        }
        break;
      }

      case 'youtube': {
        const oembed = await fetchOEmbed(`https://www.youtube.com/oembed?url=${encodeURIComponent(link.url)}&format=json`);
        if (oembed) {
          result.metadata = {
            title: oembed.title || null,
            author: oembed.author_name || null,
            authorUrl: oembed.author_url || null,
            thumbnail: oembed.thumbnail_url || null,
          };
        } else {
          result.fetchError = 'oEmbed failed — use WebSearch to look up this YouTube video';
        }
        break;
      }

      case 'instagram': {
        // Instagram oEmbed requires Facebook app token — extract shortcode for search
        const shortcodeMatch = link.url.match(/\/(p|reel)\/([\w-]+)/);
        const shortcode = shortcodeMatch ? shortcodeMatch[2] : null;
        // Try OG tags first (sometimes works)
        const og = await fetchOgTags(link.url);
        if (og && og.title && og.title !== 'Instagram') {
          result.metadata = { title: og.title, description: og.description };
        } else {
          // Build a helpful search hint from the URL structure
          const author = link.url.match(/instagram\.com\/([^/]+)\//)?.[1];
          result.fetchError = `Instagram page not directly accessible. MANDATORY: WebSearch for "instagram ${shortcode || ''} ${author || ''} site:instagram.com" to find what this post is about. DO NOT tell the user you can't access it.`;
        }
        break;
      }

      case 'twitter': {
        // Twitter/X oEmbed is unreliable — use OG tags or WebSearch
        const og = await fetchOgTags(link.url);
        if (og && og.title) {
          result.metadata = { title: og.title, description: og.description };
        } else {
          result.fetchError = 'Could not fetch — use WebSearch to look up this post';
        }
        break;
      }

      default: {
        // Eventbrite, Yelp, Google Maps, Reddit — try OG tags
        const resolved = await resolveShortUrl(link.url);
        result.resolvedUrl = resolved;
        const og = await fetchOgTags(resolved);
        if (og && (og.title || og.description)) {
          result.metadata = {
            title: og.title || null,
            description: og.description || null,
            type: og.type || null,
            image: og.image || null,
          };
        } else {
          result.fetchError = `Could not fetch metadata — use WebSearch to look up this ${link.platform} link`;
        }
        break;
      }
    }
  } catch (err) {
    result.fetchError = `Fetch failed: ${err.message} — use WebSearch as fallback`;
  }

  return result;
}

// --- Content Classification ---

const CONTENT_KEYWORDS = {
  event: /\b(concert|show|festival|tickets?|live|tour|performance|comedy|standup|sign ?up|audition|deadline|submissions?|rsvp|event|gala|opening|premiere)\b/i,
  restaurant: /\b(restaurant|cafe|caf[eé]|bar|food|menu|reserv|brunch|dinner|lunch|eat|dining|bistro|pizz|sushi|taco|burger|bbq|bakery|ramen)\b/i,
  travel: /\b(hotel|resort|travel|destination|visit|trip|vacation|airbnb|flight|hostel|getaway|itinerary)\b/i,
  recipe: /\b(recipe|cook|ingredient|bake|homemade|meal prep|kitchen|tablespoon|teaspoon|cups? of)\b/i,
  product: /\b(buy|shop|price|deal|sale|discount|coupon|order|amazon|target|walmart|etsy)\b/i,
  activity: /\b(hike|hiking|kayak|tour|adventure|experience|book now|class|workshop|lesson|escape room|spa|gym|yoga|climbing)\b/i,
};

// Platform-based type hints when metadata is unavailable
const PLATFORM_TYPE_HINTS = {
  yelp: 'restaurant',
  eventbrite: 'event',
  'google-maps': 'restaurant', // most Maps links are places to eat/visit
};

function classifyContentType(metadata, platform) {
  if (metadata) {
    const text = [metadata.title, metadata.description, metadata.author].filter(Boolean).join(' ');
    for (const [type, regex] of Object.entries(CONTENT_KEYWORDS)) {
      if (regex.test(text)) return type;
    }
  }
  // Fall back to platform hint
  return PLATFORM_TYPE_HINTS[platform] || 'general';
}

// --- Public API ---

/**
 * Enrich detected links with pre-fetched metadata and content classification.
 * Runs all fetches in parallel with a 3-second overall timeout.
 */
async function enrichLinks(links) {
  if (!links || links.length === 0) return [];

  const startTime = Date.now();

  const enriched = await Promise.race([
    Promise.allSettled(links.map(fetchLinkMetadata)),
    new Promise(resolve => setTimeout(() => resolve(links.map(l => ({
      status: 'fulfilled',
      value: { ...l, metadata: null, resolvedUrl: l.url, fetchError: 'Timeout — use WebSearch as fallback' },
    }))), 3000)),
  ]);

  const results = enriched.map(r => {
    const link = r.status === 'fulfilled' ? r.value : {
      ...r.reason, metadata: null, fetchError: 'Fetch failed — use WebSearch as fallback',
    };
    link.contentType = classifyContentType(link.metadata, link.platform);
    return link;
  });

  console.log(`[enrichLinks] ${results.length} link(s) enriched in ${Date.now() - startTime}ms`);
  return results;
}

/**
 * Build an action-oriented prompt from enriched links.
 */
function buildSmartPrompt(enrichedLinks) {
  if (!enrichedLinks || enrichedLinks.length === 0) return '';

  const linkBlocks = enrichedLinks.map((link, i) => {
    const lines = [`Link ${i + 1}: [${link.platform}] ${link.resolvedUrl || link.url}`];
    if (link.metadata) {
      if (link.metadata.title) lines.push(`  Title: ${link.metadata.title}`);
      if (link.metadata.author) lines.push(`  Author: ${link.metadata.author}`);
      if (link.metadata.description) lines.push(`  Description: ${link.metadata.description.substring(0, 200)}`);
    }
    lines.push(`  Content type (hint): ${link.contentType}`);
    if (link.fetchError) lines.push(`  ⚠️ ${link.fetchError}`);
    return lines.join('\n');
  }).join('\n\n');

  return [
    '[LINK DETECTED — pre-fetched metadata below]',
    '',
    linkBlocks,
    '',
    '[ACTION PLAYBOOK — take the FIRST matching action set based on content type]',
    '',
    'IF event/concert/show/signup:',
    '  - WebSearch for ticket/signup links and prices',
    '  - Note the date(s) and location',
    '  - Offer to add it to their Google Calendar',
    '  - Mention venue, time, age restrictions, dress code if findable',
    '',
    'IF restaurant/food/bar:',
    '  - WebSearch for hours, menu, and reservation links (OpenTable/Yelp/Google)',
    '  - Note price range ($ to $$$$) and popular dishes',
    '  - Suggest best time to go (avoid waits)',
    '  - Offer to help make a reservation or add a dinner plan to calendar',
    '',
    'IF travel/destination:',
    '  - Distance and drive time from the Bay Area / Alameda CA',
    '  - Current weather at destination',
    '  - Best time to visit, estimated cost per person',
    '  - Offer to suggest a weekend on their calendar',
    '',
    'IF recipe/cooking:',
    '  - List the key ingredients',
    '  - Note prep time and difficulty',
    '  - Offer to suggest a free evening on their calendar to make it',
    '',
    'IF product/shopping:',
    '  - WebSearch for price comparisons and reviews',
    '  - Note where to buy and any current deals',
    '',
    'IF activity/experience:',
    '  - Location, hours, pricing, booking links',
    '  - WebSearch for reviews and tips',
    '  - Offer to add it to their calendar',
    '',
    'IF general (or unsure):',
    '  - Summarize what the content is about',
    '  - If it references a place, event, or activity, treat as that type',
    '  - If purely entertainment, give a brief natural reaction',
    '',
    'RESPONSE RULES:',
    '- 2-4 sentences, casual Discord tone. Lead with the most useful/actionable info.',
    '- End with ONE specific next-step offer ("Want me to add this to your calendar?", "Should I find tickets?", "Want me to check reservation availability?")',
    '- NEVER say "I can\'t access this", "I can\'t view this", or "this platform is locked". You have WebSearch — USE IT.',
    '- If metadata is above, use it directly. If fetch failed (⚠️), IMMEDIATELY WebSearch for the content. No excuses, no apologies.',
    '- NEVER ask the user to tell you what the link is. Figure it out yourself via WebSearch.',
    '',
  ].join('\n');
}

/**
 * Legacy sync prompt builder — backward compat for callers that don't pre-fetch.
 */
function buildExtractionPrompt(links) {
  if (!links || links.length === 0) return '';
  // Build a basic prompt without metadata
  const enriched = links.map(l => ({
    ...l,
    resolvedUrl: l.url,
    metadata: null,
    contentType: 'general',
    fetchError: 'Metadata not pre-fetched — use WebSearch/WebFetch to research this link',
  }));
  return buildSmartPrompt(enriched);
}

module.exports = { detectLinks, buildExtractionPrompt, buildSmartPrompt, enrichLinks };
