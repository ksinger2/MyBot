/**
 * Media Pulse — seed a scheduled dm-task job for the owner on first boot.
 * Delivers to Signal DM every 5 hours between 8am–8pm PT.
 * Appears in the setup page under "Scheduled Jobs" so it can be edited.
 */

const MEDIA_PULSE_DESCRIPTION = 'Media Pulse';
const MEDIA_PULSE_CRON = '0 8,13,18 * * *'; // 8am, 1pm, 6pm Pacific
const MEDIA_PULSE_TZ = 'America/Los_Angeles';

const MEDIA_PULSE_PROMPT = `You are a media industry intelligence scanner. Find the LATEST news across media, streaming, and gaming — prioritizing stories from the last 5 hours.

RECENCY RULES (CRITICAL):
- STRONGLY PRIORITIZE stories from the last 5 hours
- Include up to 12 hours old only if highly significant
- IGNORE anything older than 24 hours
- Order NEWEST FIRST

SEARCH THESE TOPICS using WebSearch:
- "Disney streaming acquisition content announcement" (Disney+, Hulu, ESPN+, ABC, Pixar, Marvel, Lucasfilm)
- "Netflix original series format announcement deal" (new shows, formats, gaming, tech features)
- "Amazon Prime Video MGM original content deal"
- "YouTube new feature creator monetization Shorts"
- "TikTok mini series short-form format content"
- "Epic Games Fortnite Unreal Engine metaverse gaming deal"
- "Roblox gaming platform acquisition funding"
- "media company acquisition merger deal funding"
- "ByteDance TikTok Chinese media streaming news"
- "Tencent iQiyi Bilibili Kuaishou Chinese media"
- "streaming wars subscriber growth bundle deal"
- "media startup launch funding round"
- "new content format interactive AI-generated media"
- "Spotify podcast video content news"
- "Warner Bros Discovery Paramount CBS media deal"

PRIORITY SOURCES: Use site: operators to find from these outlets:
variety.com, hollywoodreporter.com, deadline.com, forbes.com, bloomberg.com, theverge.com, techcrunch.com, reuters.com, wired.com, axios.com, thewrap.com, streamtvinsider.com

FORMAT RULES (follow exactly):
- Header: **📺 Media Pulse** — then current time in Pacific Time (e.g. "**📺 Media Pulse** — 1:00 PM PT")
- Each bullet: hyperlink ONLY the first word (company or source name), rest of sentence is plain text, time-ago tag at end
- Format: • [CompanyName](url) does thing — brief detail (Xh ago)
- The URL is hidden — only the company/source name is clickable. DO NOT show the raw URL anywhere.
- Example: • [Netflix](url) launches interactive choose-your-own-adventure format for mobile (2h ago)
- Example: • [Disney](url) acquires gaming studio Funcom for $600M metaverse push (4h ago)
- NO intro, NO outro, NO commentary, NO sources list at the bottom
- Max 12 bullets. If nothing new in last 5 hours: output ONLY "**📺 Media Pulse** — Nothing new since last check."
- All links MUST be [text](url) format. Suppress embeds by wrapping URLs in angle brackets if needed.`;

/**
 * Seed the media pulse job for the Signal owner if it doesn't already exist.
 * Called once on bot startup.
 */
function seedMediaPulse() {
  // Support both SIGNAL_OWNER_NUMBER (primary) and SIGNAL_OWNER (legacy alias)
  const ownerPhone = process.env.SIGNAL_OWNER_NUMBER || process.env.SIGNAL_OWNER;
  if (!ownerPhone) {
    console.log('[media-pulse] No SIGNAL_OWNER_NUMBER set — skipping seed');
    return;
  }

  try {
    const { getUserSchedules, addSchedule } = require('./schedules-storage');
    const existing = getUserSchedules(ownerPhone).filter(s => s.type === 'dm-task');
    const alreadySeeded = existing.some(s => s.description === MEDIA_PULSE_DESCRIPTION);

    if (alreadySeeded) {
      console.log('[media-pulse] Job already exists — skipping seed');
      return;
    }

    const sched = addSchedule({
      userId: ownerPhone,
      channelId: null,
      message: MEDIA_PULSE_PROMPT,
      cronRule: MEDIA_PULSE_CRON,
      description: MEDIA_PULSE_DESCRIPTION,
      type: 'dm-task',
      cwd: null,
      timezone: MEDIA_PULSE_TZ,
    });

    console.log(`[media-pulse] Seeded job #${sched.id} — runs 8am/1pm/6pm PT via Signal DM to ${ownerPhone}`);
    return sched;
  } catch (err) {
    console.warn('[media-pulse] Seed failed:', err.message);
  }
}

module.exports = { seedMediaPulse };
