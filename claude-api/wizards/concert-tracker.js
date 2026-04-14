/**
 * Concert tracker setup wizard — interactive DM setup for the concert
 * price tracking scheduled job.
 *
 * Flow:
 *   1. Show full artist list from Spotify, let user add/remove
 *   2. Confirm location (default from profile)
 *   3. How often to check
 *   4. Price alert threshold (optional)
 *   5. Save scheduled job
 */

const { addSchedule } = require('../schedules-storage');
const { getProfile } = require('../user-profiles');

function buildConcertTrackerWizard() {
  return {
    type: 'concert-tracker',
    silent: true,
    steps: [
      {
        key: 'reviewArtists',
        prompt: data => {
          const profile = data._profile;
          const artists = (profile?.tags || [])
            .filter(t => t.category === 'Artist')
            .map(t => t.label);
          // Store the full list and phone for refresh
          data._artistList = [...artists];
          data._phone = profile?.phone || null;
          if (artists.length > 0) {
            const numbered = artists.map((a, i) => `${i + 1}. ${a}`).join('\n');
            return `Let's set up your concert price tracker! 🎵\n\nHere are your artists:\n${numbered}\n\nWant to make changes?\n- "remove 3, 7" to remove by number\n- "add Beyoncé, The Weeknd" to add more\n- "looks good" to continue with this list`;
          }
          return "Let's set up your concert price tracker! 🎵\n\nYou don't have any Spotify artists imported yet. List the artists you want to track, separated by commas:";
        },
        validate: (v, data) => {
          const t = v.trim().toLowerCase();
          if (t.length === 0) return "Tell me what to do with the list.";

          // Handle add/remove/confirm
          if (/^(looks good|good|yes|confirm|ok|done|all|keep)/.test(t)) {
            if (!data._artistList || data._artistList.length === 0) return "You don't have any artists yet — add some first.";
            return true;
          }

          // Remove by number: "remove 3, 7, 12"
          if (t.startsWith('remove')) {
            const nums = t.replace(/^remove[:\s]*/i, '').split(/[,\s]+/).map(n => parseInt(n, 10)).filter(n => !isNaN(n));
            if (nums.length === 0) return "Which numbers to remove? e.g. \"remove 3, 7\"";
            data._artistList = (data._artistList || []).filter((_, i) => !nums.includes(i + 1));
            const numbered = data._artistList.map((a, i) => `${i + 1}. ${a}`).join('\n');
            return `Removed. Updated list:\n${numbered}\n\nAnymore changes? Or "looks good" to continue.`;
          }

          // Add artists: "add Beyoncé, The Weeknd"
          if (t.startsWith('add')) {
            const newArtists = v.replace(/^add\s+/i, '').split(',').map(a => a.trim()).filter(Boolean);
            if (newArtists.length === 0) return "Which artists? e.g. \"add Beyoncé, The Weeknd\"";
            if (!data._artistList) data._artistList = [];
            data._artistList.push(...newArtists);
            const numbered = data._artistList.map((a, i) => `${i + 1}. ${a}`).join('\n');
            return `Added! Updated list:\n${numbered}\n\nAnymore changes? Or "looks good" to continue.`;
          }

          // Refresh from Spotify (broad matching for natural language)
          if (t.startsWith('refresh') || t.startsWith('repull') || t.startsWith('re-pull') || t.includes('pull') || t.includes('refresh') || t.includes('reconnect') || t.includes('reload') || t.includes('update list') || t.includes('re-import')) {
            const freshProfile = require('../user-profiles').getProfile(data._phone || message?._signalSenderId);
            const freshArtists = (freshProfile?.tags || []).filter(ta => ta.category === 'Artist').map(ta => ta.label);
            data._artistList = [...freshArtists];
            const numbered = data._artistList.map((a, i) => `${i + 1}. ${a}`).join('\n');
            return `Refreshed! ${data._artistList.length} artists:\n${numbered}\n\nMake changes or "looks good" to continue.`;
          }

          // Search / question about the list: "is X on the list?", "do I have X?", "where is X?"
          const searchPatterns = [
            /(?:is|does|do i have|where is|find|search|check|have)\s+(.+?)(?:\s+on\s+(?:the|my)\s+list)?[?]?$/i,
            /^(?:wait\s+)?(?:is|does|do)\s+(.+?)(?:\s+on\s+(?:the|my|this)\s+list)?[?]?$/i,
          ];
          for (const pat of searchPatterns) {
            const searchMatch = t.match(pat);
            if (searchMatch) {
              const query = searchMatch[1].trim().toLowerCase();
              const list = data._artistList || [];
              const found = list.filter(a => a.toLowerCase().includes(query));
              if (found.length > 0) {
                return `Yes! Found: ${found.join(', ')}\n\nMake changes or "looks good" to continue.`;
              } else {
                return `No "${searchMatch[1].trim()}" on the list. Say "add ${searchMatch[1].trim()}" to add them.\n\nMake changes or "looks good" to continue.`;
              }
            }
          }

          // If they just type artist names (no Spotify artists), treat as the list
          if (!data._artistList || data._artistList.length === 0) {
            data._artistList = v.split(',').map(a => a.trim()).filter(Boolean);
            if (data._artistList.length === 0) return "Give me at least one artist name.";
            return true;
          }

          return "Reply \"looks good\" to continue, \"remove #\" to remove, or \"add Name\" to add.";
        },
      },
      {
        key: 'location',
        prompt: data => {
          const profile = data._profile;
          if (profile?.location) {
            return `Search area? Your profile says ${profile.location}. I'll search within 50 miles.\n\nReply "yes" to use that, or type a different city.`;
          }
          return "What area should I search? (e.g. \"Alameda, CA\") I'll look within 50 miles.";
        },
        validate: v => v.trim().length > 0 ? true : "Give me a location.",
      },
      {
        key: 'frequency',
        prompt: "How often should I check?\n\n- \"every 6 hours\" (recommended)\n- \"daily\"\n- \"weekly\"",
        validate: v => v.trim().length > 0 ? true : "Pick a frequency.",
      },
      {
        key: 'priceAlert',
        prompt: "Alert me when tickets are under a price? (e.g. \"$100\"). Reply \"no\" to skip.",
        validate: v => {
          const t = v.trim().toLowerCase();
          if (/^(no|skip|nah|nope)$/.test(t)) return true;
          if (/^\$?\d+$/.test(t.replace(',', ''))) return true;
          return "Dollar amount (like $100) or \"no\" to skip.";
        },
      },
    ],
    onComplete: async (data, message, state) => {
      const phone = message._signalSenderId || message.author?.id;
      if (!phone) { await message.reply("Couldn't save."); return; }
      const profile = getProfile(phone) || {};

      const artists = data._artistList || [];
      let location = data.location.trim();
      if (/^(yes|y|yeah|yep|sure|ok)$/i.test(location)) location = profile.location || 'my area';

      let priceThreshold = null;
      const pi = data.priceAlert.trim().toLowerCase();
      if (!/^(no|skip|nah|nope)$/.test(pi)) priceThreshold = parseInt(pi.replace(/[$,]/g, ''), 10);

      let freq = data.frequency.trim().toLowerCase();
      if (freq === 'twice daily') freq = 'every 12 hours';
      if (freq === 'weekly') freq = 'friday at 10am';

      const artistList = artists.slice(0, 20).join(', ');
      let prompt = `Check for upcoming concerts by these artists within 50 miles of ${location}: ${artistList}. For each show, get ticket prices using [CONCERT_PRICES:] tags. Show a summary with the overall minimum and average price across all platforms for each concert. Highlight the best deals.`;
      if (priceThreshold) prompt += ` Alert if any tickets under $${priceThreshold}.`;
      prompt += ` Only events in the next 3 months. Show price trends if available.`;

      try {
        addSchedule(phone, { type: 'dm-task', description: 'Concert Price Tracker', message: prompt, frequency: freq });
        const summary = [
          "Concert tracker is set! 🎵",
          '',
          `Artists (${artists.length}): ${artists.slice(0, 8).join(', ')}${artists.length > 8 ? ` +${artists.length - 8} more` : ''}`,
          `📍 Within 50mi of ${location}`,
          `⏰ ${data.frequency.trim()}`,
          priceThreshold ? `💰 Alert under $${priceThreshold}` : '',
          '',
          "Edit anytime in !setup → Scheduled Jobs.",
        ].filter(Boolean).join('\n');
        await message.reply(summary);
      } catch (err) {
        await message.reply(`Failed: ${err.message}`);
      }
    },
  };
}

module.exports = { buildConcertTrackerWizard };
