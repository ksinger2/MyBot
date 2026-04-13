// Morning Briefing Configuration
// Edit this file to customize your daily briefing.
// Set enabled: false to disable, or leave channelId empty to skip.

module.exports = {
  // Master switch
  enabled: true,

  // Cron schedule: "0 9 * * *" = every day at 9:00
  // See https://crontab.guru for help with cron expressions
  schedule: '0 9 * * *',
  timezone: 'America/Los_Angeles',

  // Evening check-in: ask for tomorrow's tasks at 10 PM
  eveningCheckin: {
    enabled: true,
    schedule: '0 22 * * *',
  },

  // Sunday weekly preview: "what's coming this week" at noon on Sundays
  weeklyPreview: {
    enabled: true,
    schedule: '0 12 * * 0',  // noon every Sunday
  },

  // Discord channel ID where the briefing is posted
  // Right-click a channel > Copy Channel ID (enable Developer Mode in Discord settings)
  channelId: '1481550166501626039',

  // Channel for error alerts
  errorChannelId: '1481852862634918066',

  // Identity and personality for the briefing (null = use bot defaults)
  identity: null,
  personality: null,

  // --- Modules ---

  stocks: {
    enabled: true,
    tickers: ['GOOG', 'IVV', 'MUB', 'VEA', 'IJH', 'VWO', 'IJR', 'SUB'],
    holdings: {
      GOOG: { shares: 2796.43, avgCost: 311.76 },
      IVV:  { shares: 128.96,  avgCost: 442.95 },
      MUB:  { shares: 377.65,  avgCost: 112.50 },
      VEA:  { shares: 523.45,  avgCost: 49.99 },
      IJH:  { shares: 291.30,  avgCost: 53.86 },
      VWO:  { shares: 176.68,  avgCost: 48.15 },
      IJR:  { shares: 70.33,   avgCost: 107.22 },
      SUB:  { shares: 72.71,   avgCost: 106.48 },
    },
  },

  weather: {
    enabled: true,
    location: 'Alameda, California',
    // Units: 'u' for Fahrenheit, 'm' for Celsius
    units: 'u',
  },

  news: {
    enabled: true,
    // Priority sources: wired.com, theverge.com, reuters.com — Claude will use site: search operators for these
    topics: [
      { query: 'Iran war conflict latest', timeframe: '12 hours', depth: 'detailed' },
      { query: 'tech acquisitions mergers', timeframe: '2 days', depth: 'detailed' },
      { query: 'Anthropic Claude AI announcements', timeframe: '3 days', depth: 'detailed' },
      { query: 'OpenAI Google DeepMind AI news', timeframe: '2 days', depth: 'brief' },
      { query: 'major world events breaking news', timeframe: '12 hours', depth: 'brief' },
      { query: 'site:wired.com OR site:theverge.com tech AI news', timeframe: '2 days', depth: 'brief' },
      { query: 'site:reuters.com breaking news world', timeframe: '12 hours', depth: 'brief' },
    ],
  },

  motivation: {
    enabled: true,
    userContext: 'Karen is currently unemployed and studying to get back into the job market. She needs real motivation — not cheesy affirmations. Encourage her to go for walks, move her body, feel confident, and validate herself. Include a mindfulness moment — suggest a specific meditation, breathing exercise, or mindful pause she can do today. Keep it grounded and practical, not woo-woo.',
  },

  jobs: {
    enabled: true,
    titles: ['Senior Product Manager', 'Staff Product Manager', 'Director of Product Management'],
    locations: ['United States', 'Remote'],
    // Companies and categories to search for new postings
    companyCategories: [
      'AI companies (Anthropic, OpenAI, Google DeepMind, Cohere, Mistral, Perplexity, Scale AI, Hugging Face, Runway, Stability AI, Character AI, Inflection, Adept, Databricks)',
      'Big tech (Google, Apple, Meta, Microsoft, Amazon, Netflix, Spotify, Salesforce)',
      'Media companies (Disney, Warner Bros Discovery, NYT, Condé Nast, Vox Media, Spotify)',
      'Hot startups (Figma, Notion, Linear, Vercel, Retool, Replit, Arc, Ramp, Brex)',
    ],
    timeframe: '7 days',
  },
};
