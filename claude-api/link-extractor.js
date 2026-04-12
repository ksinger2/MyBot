/**
 * link-extractor.js
 *
 * Detects social media and location links in Discord messages, pre-fetches
 * metadata (oEmbed, OG tags), classifies content type, and builds action-oriented
 * prompts for Claude CLI.
 */

/**
 * SSRF gate for yt-dlp invocations. yt-dlp will happily fetch file:// URIs,
 * internal HTTP endpoints, and cloud metadata services (169.254.169.254) if
 * given the chance. We lock it down to HTTPS + a hostname allowlist of known
 * social/video sources, and we reject IP literals outright. Adding a new
 * platform is a one-line regex addition.
 */
function _isUrlSafeForYtdlp(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  // Scheme: HTTPS only. No file://, no http:// (cleartext), no data:, no ftp:.
  if (parsed.protocol !== 'https:') return false;
  // Hostname allowlist: only known social/video sources.
  const allowedHosts = [
    /(^|\.)tiktok\.com$/i,
    /(^|\.)instagram\.com$/i,
    /(^|\.)youtube\.com$/i,
    /(^|\.)youtu\.be$/i,
    /(^|\.)twitter\.com$/i,
    /(^|\.)x\.com$/i,
    /(^|\.)facebook\.com$/i,
    /(^|\.)vimeo\.com$/i,
    /(^|\.)reddit\.com$/i,
  ];
  const hostname = parsed.hostname.toLowerCase();
  if (!allowedHosts.some(re => re.test(hostname))) return false;
  // Block IP literals (defeats DNS rebinding to private space).
  if (/^(\d+\.){3}\d+$/.test(hostname)) return false;
  if (hostname.includes(':')) return false; // IPv6 literal
  return true;
}

/**
 * Minimal SSRF gate for fetch()-based metadata lookups (oEmbed / OG tags).
 * Less restrictive than the yt-dlp gate — oEmbed legitimately hits many
 * hosts — but still blocks private/loopback/link-local IP literals and
 * non-HTTP(S) schemes. Returns false on anything suspicious.
 */
function _isUrlSafeForFetch(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  // Block IPv4 literals in private/loopback/link-local ranges
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (a === 10) return false;                              // 10.0.0.0/8
    if (a === 127) return false;                             // loopback
    if (a === 169 && b === 254) return false;                // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;       // 172.16.0.0/12
    if (a === 192 && b === 168) return false;                // 192.168.0.0/16
    if (a === 0) return false;                               // 0.0.0.0/8
  }
  // Block obvious IPv6 literals (anything with colons in hostname)
  if (hostname.includes(':')) return false;
  // Block "localhost" and common internal names
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
  return true;
}

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
  if (!_isUrlSafeForFetch(url)) return url;
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
      if (/^https?:\/\//.test(location)) {
        // Re-gate: the redirect target could point to cloud metadata, private IPs, etc.
        if (!_isUrlSafeForFetch(location)) {
          console.log(`[link-extractor] rejected unsafe redirect: ${location.substring(0, 80)}`);
          return url;
        }
        return location;
      }
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
  if (!_isUrlSafeForFetch(oembedUrl)) return null;
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
  if (!_isUrlSafeForFetch(url)) return null;
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

    // Re-gate og:image — it's an attacker-controlled URL from the page's HTML
    // that surfaces in Claude's prompt and could point to cloud metadata / private IPs.
    const rawImage = tags['og:image'] || null;
    const safeImage = rawImage && _isUrlSafeForFetch(rawImage) ? rawImage : null;

    return {
      title: tags['og:title'] || tags.title || null,
      description: tags['og:description'] || tags.description || null,
      type: tags['og:type'] || null,
      image: safeImage,
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
          // Re-gate URLs from oEmbed response — attacker-controlled content
          const authorUrl = oembed.author_url && _isUrlSafeForFetch(oembed.author_url) ? oembed.author_url : null;
          const thumbnail = oembed.thumbnail_url && _isUrlSafeForFetch(oembed.thumbnail_url) ? oembed.thumbnail_url : null;
          result.metadata = {
            title: oembed.title || null,
            author: oembed.author_name || null,
            authorUrl,
            thumbnail,
          };
        } else {
          result.fetchError = 'oEmbed failed — use WebSearch to look up this TikTok';
        }
        break;
      }

      case 'youtube': {
        const oembed = await fetchOEmbed(`https://www.youtube.com/oembed?url=${encodeURIComponent(link.url)}&format=json`);
        if (oembed) {
          // Re-gate URLs from oEmbed response — attacker-controlled content
          const authorUrl = oembed.author_url && _isUrlSafeForFetch(oembed.author_url) ? oembed.author_url : null;
          const thumbnail = oembed.thumbnail_url && _isUrlSafeForFetch(oembed.thumbnail_url) ? oembed.thumbnail_url : null;
          result.metadata = {
            title: oembed.title || null,
            author: oembed.author_name || null,
            authorUrl,
            thumbnail,
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

// --- Video transcript extraction ---
//
// For social video links (TikTok, Instagram Reels, YouTube), oEmbed only gives
// us title/author/thumbnail — not the actual content. To answer "tldr this video"
// or "plan for us based on what's in this video" we need the spoken content.
//
// Pipeline: yt-dlp → mp3 audio file → OpenAI Whisper API → text transcript
// Requires: yt-dlp, ffmpeg, OPENAI_API_KEY (all set up in Dockerfile + env)

const VIDEO_TRANSCRIBABLE_PLATFORMS = new Set(['tiktok', 'instagram', 'youtube']);
const TRANSCRIPT_TIMEOUT_MS = 60000; // 60s — Whisper for short clips is fast
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24MB — Whisper API limit is 25MB
const _transcriptCache = new Map(); // url → transcript (in-memory, lifetime of process)
const TRANSCRIPT_CACHE_MAX = 200;

/**
 * Download a social video as audio and transcribe via OpenAI Whisper.
 * Returns the transcript text, or null on failure.
 */
async function fetchVideoTranscript(url) {
  if (!url) return null;
  // SSRF gate: yt-dlp runs as a subprocess and will fetch file://,
  // http://169.254.169.254 (cloud metadata), etc. without asking. Only
  // allow HTTPS URLs on a narrow allowlist of known video sources.
  if (!_isUrlSafeForYtdlp(url)) {
    console.warn(`[link-extractor] rejected unsafe URL for yt-dlp: ${String(url).substring(0, 80)}`);
    return null;
  }
  if (_transcriptCache.has(url)) return _transcriptCache.get(url);
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[transcript] OPENAI_API_KEY not set — cannot transcribe');
    return null;
  }

  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { spawn } = require('child_process');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
  const outputTemplate = path.join(tmpDir, 'audio.%(ext)s');

  try {
    // Step 1: yt-dlp → audio. Use mp3 encoding for Whisper compatibility.
    // -x extracts audio, --audio-format mp3 converts via ffmpeg, --quiet keeps logs clean.
    // --max-filesize protects against giant videos.
    await new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', [
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '5', // VBR ~130kbps — good enough for speech
        '--max-filesize', '50m',
        '--no-playlist',
        '--no-warnings',
        '--quiet',
        // Bypass bot-detection: use a real browser User-Agent and enable
        // cookies extraction. TikTok/Instagram block default yt-dlp UA.
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        '--referer', url,
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        // Proxy support: set YT_DLP_PROXY in .env to route through VPN/proxy.
        // ExpressVPN on the Windows host auto-routes container traffic, but a
        // persistent SOCKS5/HTTP proxy can be configured here for reliability.
        ...(process.env.YT_DLP_PROXY ? ['--proxy', process.env.YT_DLP_PROXY] : []),
        '-o', outputTemplate,
        url,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`yt-dlp timeout after ${TRANSCRIPT_TIMEOUT_MS}ms`));
      }, TRANSCRIPT_TIMEOUT_MS);
      proc.on('close', code => {
        clearTimeout(t);
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp exit ${code}: ${stderr.substring(0, 200)}`));
      });
      proc.on('error', err => {
        clearTimeout(t);
        reject(err);
      });
    });

    // Find the produced mp3 (yt-dlp picks the actual extension at runtime)
    const files = fs.readdirSync(tmpDir).filter(f => /\.(mp3|m4a|opus|ogg|wav)$/i.test(f));
    if (files.length === 0) {
      throw new Error('yt-dlp produced no audio file');
    }
    const audioPath = path.join(tmpDir, files[0]);
    const stat = fs.statSync(audioPath);
    if (stat.size > MAX_AUDIO_BYTES) {
      throw new Error(`audio file too large (${stat.size} > ${MAX_AUDIO_BYTES})`);
    }

    // Step 2: send to OpenAI Whisper. Use the SDK for proper multipart encoding.
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'text',
    });
    const text = (typeof transcription === 'string' ? transcription : transcription.text || '').trim();

    // Cache (with size cap)
    if (_transcriptCache.size >= TRANSCRIPT_CACHE_MAX) {
      const firstKey = _transcriptCache.keys().next().value;
      _transcriptCache.delete(firstKey);
    }
    _transcriptCache.set(url, text);
    return text;
  } catch (err) {
    console.warn(`[transcript] Failed for ${url}: ${err.message}`);
    return null;
  } finally {
    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// --- Public API ---

/**
 * Enrich detected links with pre-fetched metadata and content classification.
 * Runs metadata fetches in parallel with a 3-second timeout. For transcribable
 * social videos (TikTok, Instagram, YouTube), ALSO kicks off a Whisper transcript
 * extraction in parallel with a longer timeout — this is what enables "tldr the
 * video" to actually summarize the video's content.
 */
async function enrichLinks(links) {
  if (!links || links.length === 0) return [];

  const startTime = Date.now();

  // Phase 1: metadata (oEmbed/OG tags) — fast, short timeout
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

  // Phase 2: video transcripts for TikTok/Instagram/YouTube — slower, longer timeout
  // Run in parallel for all transcribable links
  const transcribableLinks = results.filter(r => VIDEO_TRANSCRIBABLE_PLATFORMS.has(r.platform));
  if (transcribableLinks.length > 0) {
    await Promise.allSettled(transcribableLinks.map(async (link) => {
      const transcript = await fetchVideoTranscript(link.resolvedUrl || link.url);
      if (transcript) {
        link.transcript = transcript;
      }
    }));
  }

  console.log(`[enrichLinks] ${results.length} link(s) enriched in ${Date.now() - startTime}ms (${transcribableLinks.filter(l => l.transcript).length} transcribed)`);
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
    // Whisper-extracted spoken content from the video itself. This is the
    // ACTUAL content of the video, not just metadata. Treat it as authoritative
    // for "what is this video about" / "tldr" / "what event is in this video".
    if (link.transcript) {
      const t = link.transcript.length > 3500 ? link.transcript.substring(0, 3500) + '...(truncated)' : link.transcript;
      lines.push(`  📝 VIDEO TRANSCRIPT (extracted via Whisper — this is what the video actually says):`);
      lines.push(`  """`);
      lines.push(t.split('\n').map(l => '  ' + l).join('\n'));
      lines.push(`  """`);
    }
    if (link.fetchError && !link.transcript) lines.push(`  ⚠️ ${link.fetchError}`);
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
    '- 2-4 sentences, casual tone. Lead with the most useful/actionable info.',
    '- IF a VIDEO TRANSCRIPT is provided above, USE IT as the primary source of truth for what the video is about. The transcript is what the video literally says. For "tldr" / "summarize" requests, summarize the transcript directly. For "plan for us" requests, extract dates/locations/events from the transcript.',
    '- End with ONE specific next-step offer ("Want me to add this to your calendar?", "Should I find tickets?", "Want me to check reservation availability?")',
    '- NEVER say "I can\'t access this", "I can\'t view this", or "this platform is locked". You have WebSearch AND a video transcript — USE THEM.',
    '- If metadata is above, use it directly. If fetch failed (⚠️) AND there is no transcript, IMMEDIATELY WebSearch for the content. No excuses, no apologies.',
    '- NEVER ask the user to tell you what the link is. Figure it out yourself via the transcript or WebSearch.',
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
