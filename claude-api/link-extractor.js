/**
 * link-extractor.js
 *
 * Detects social media and location links in Discord messages and builds
 * extraction prompts for Claude CLI to process them.
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
 * Detect supported social media, location, and event links in a message.
 *
 * @param {string} messageContent - The raw Discord message text
 * @returns {Array<{url: string, type: string, platform: string}>}
 */
function detectLinks(messageContent) {
  if (!messageContent || typeof messageContent !== 'string') return [];

  const results = [];
  const seen = new Set();

  for (const { platform, type, patterns } of PLATFORM_PATTERNS) {
    for (const regex of patterns) {
      // Reset lastIndex since we reuse regex objects with the g flag
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(messageContent)) !== null) {
        const url = match[0].replace(/[)>,;]+$/, ''); // strip trailing punctuation
        if (!seen.has(url)) {
          seen.add(url);
          results.push({ url, type, platform });
        }
      }
    }
  }

  return results;
}

/**
 * Build an extraction-prompt string that will be prepended to the user's
 * message before sending it to Claude CLI.  Claude will execute the actual
 * fetching/browsing — this just tells it what to do.
 *
 * @param {Array<{url: string, type: string, platform: string}>} links
 * @returns {string} Instruction text for Claude
 */
function buildExtractionPrompt(links) {
  if (!links || links.length === 0) return '';

  const linkList = links
    .map((l, i) => `${i + 1}. [${l.platform}] ${l.url}`)
    .join('\n');

  return [
    '[LINK DETECTED]',
    'The user shared these links:',
    '',
    linkList,
    '',
    'Use WebFetch to load each URL and extract what it is (place, event, video, etc.).',
    'Then give a short, helpful summary — what it is, where it is (if a location), key details.',
    'If it\'s a place or event, mention anything useful like hours, price, or what to expect.',
    'Keep it casual and Discord-concise. Respond naturally to whatever the user said along with the link.',
    '',
  ].join('\n');
}

module.exports = { detectLinks, buildExtractionPrompt };
