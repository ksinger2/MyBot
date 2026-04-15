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

const { addSchedule, getUserSchedules, removeSchedule } = require('../schedules-storage');
const { getProfile } = require('../user-profiles');
const { parseFrequency } = require('../parse-frequency');

function buildConcertTrackerWizard() {
  return {
    type: 'concert-tracker',
    silent: true,
    // Partial-save hook — invoked by cancelWizard (explicit !cancel,
    // silent escape on a new !command, or any other cancellation path)
    // with whatever data has been collected so far. Saves the curated
    // artist list even if the user never made it to "looks good" +
    // location + frequency + priceAlert. This was Karen's explicit
    // requirement: "if the user exits the flow early it should still
    // save whatever it collected".
    onCancel: async (data, message, _state) => {
      const phone = message._signalSenderId || message.author?.id;
      if (!phone) return;
      const artists = Array.isArray(data._artistList) ? data._artistList : [];
      if (artists.length === 0) return;
      try {
        const { setProfile, getProfile: _verifyGetProfile } = require('../user-profiles');
        setProfile(phone, { concert_tracker_artists: artists });
        // Deterministic paper trail — read back the value that landed on
        // disk so a silent setProfile regression shows up as a mismatch.
        const _verify = _verifyGetProfile(phone);
        const _savedCount = Array.isArray(_verify?.concert_tracker_artists) ? _verify.concert_tracker_artists.length : 0;
        console.log(`[concert-tracker] early-exit save: ${_savedCount}/${artists.length} artists persisted for ${phone.slice(0, 4)}****`);
      } catch (err) {
        console.warn(`[concert-tracker] early-exit save failed: ${err.message}`);
      }
    },
    steps: [
      {
        key: 'reviewArtists',
        prompt: data => {
          const profile = data._profile;
          // Prefer the user's previously-curated list (from a prior wizard
          // completion) so removals persist across runs. Fall back to the
          // full Spotify-sourced Artist-tag list if there's no curated list.
          const curated = Array.isArray(profile?.concert_tracker_artists) ? profile.concert_tracker_artists : null;
          const artists = (curated && curated.length > 0)
            ? [...curated]
            : (profile?.tags || []).filter(t => t.category === 'Artist').map(t => t.label);
          data._artistList = [...artists];
          data._phone = profile?.phone || null;
          data._usingCuratedList = !!(curated && curated.length > 0);
          if (artists.length > 0) {
            const numbered = artists.map((a, i) => `${i + 1}. ${a}`).join('\n');
            const sourceNote = data._usingCuratedList
              ? '(showing your previously-saved curated list — reply "refresh" to re-pull fresh from Spotify)'
              : '';
            return `Let's set up your concert price tracker! 🎵\n\nHere are your artists:\n${numbered}\n${sourceNote}\n\nWant to make changes?\n- "remove 3, 7" to remove by number\n- "add Beyoncé, The Weeknd" to add more\n- Paste a full numbered list to replace the whole thing\n- "looks good" to continue with this list`;
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

          // KEEP-ONLY replacement — MUST come before the "remove" branch
          // because phrases like "remove everything except" start with
          // "remove" but the user's intent is to KEEP the listed items.
          // Karen hit this exact bug: she pasted
          //   "remove everything EXCEPT for: 1. Jack Johnson 2. Alabama Shakes ..."
          // and the old remove branch parsed the numbers as indexes to
          // DELETE, so it removed the items she actually wanted to keep.
          const keepPhraseRe = /\b(except|keep only|leave only|only keep|just keep|only these|remove all except|remove everything except|delete all except)\b/i;
          if (keepPhraseRe.test(t)) {
            // First try to extract a numbered list from the message.
            const numberedLineRe = /^\s*\d+[\.\)]\s+(.+?)\s*$/gm;
            const numberedMatches = [...v.matchAll(numberedLineRe)];
            if (numberedMatches.length >= 1) {
              const newList = numberedMatches
                .map(m => m[1].trim())
                .filter(name => name.length > 0 && name.length < 100);
              if (newList.length > 0) {
                data._artistList = newList;
                const numbered = data._artistList.map((a, i) => `${i + 1}. ${a}`).join('\n');
                return `Got it — keeping only these ${newList.length} artists:\n${numbered}\n\nMake changes or "looks good" to continue.`;
              }
            }
            // No numbered list — try a comma-separated list after the keep phrase.
            const afterKeep = v.replace(/^[\s\S]*?(except(?:\s+for)?|keep only|leave only|only keep|just keep|only these|remove all except|remove everything except|delete all except)[:\s]*/i, '').trim();
            if (afterKeep) {
              const commaList = afterKeep.split(/[,\n]+/).map(s => s.replace(/^\d+[\.\)]\s*/, '').trim()).filter(Boolean);
              if (commaList.length >= 1) {
                data._artistList = commaList;
                const numbered = data._artistList.map((a, i) => `${i + 1}. ${a}`).join('\n');
                return `Got it — keeping only these ${commaList.length} artist${commaList.length === 1 ? '' : 's'}:\n${numbered}\n\nMake changes or "looks good" to continue.`;
              }
            }
            return "Tell me which artists to keep — either a numbered list or a comma-separated list after 'except'.";
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

          // Pasted numbered list → treat as full replacement. Detect ≥3 lines
          // matching `^\s*\d+[\.\)]\s+.+`. This handles the "here's my curated
          // list, please replace what you have" case without requiring the user
          // to remove/add one-at-a-time. Must come BEFORE search patterns so
          // "is X on the list?" doesn't accidentally match a line like
          // "9. Is Khalid on here?".
          const numberedLineRe = /^\s*\d+[\.\)]\s+(.+?)\s*$/gm;
          const numberedMatches = [...v.matchAll(numberedLineRe)];
          if (numberedMatches.length >= 3) {
            const newList = numberedMatches
              .map(m => m[1].trim())
              .filter(name => name.length > 0 && name.length < 100);
            if (newList.length >= 3) {
              data._artistList = newList;
              const numbered = data._artistList.map((a, i) => `${i + 1}. ${a}`).join('\n');
              return `Got it — replaced with ${newList.length} artists:\n${numbered}\n\nMake changes or "looks good" to continue.`;
            }
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
        prompt: "Alert me when tickets drop below a price? You can say:\n- \"$100\" (single threshold)\n- \"$50, $100, $200\" (multiple — alert at any)\n- \"under $75\" / \"less than 150\" / \"below $200\"\n- \"no\" to skip",
        validate: v => {
          const t = v.trim().toLowerCase();
          if (/^(no|skip|nah|nope|none|n)$/.test(t)) return true;
          // Accept any input that contains at least one number. The
          // onComplete step extracts all numbers and stores them as the
          // threshold list — natural-language phrasing doesn't matter.
          if (/\d/.test(t)) return true;
          return "Give me a dollar amount (or comma-separated amounts), or \"no\" to skip. Examples: \"$75\", \"under $100\", \"$50, $100, $200\".";
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

      // Parse price thresholds from free-form input. Accept "$100",
      // "under 75", "less than $200", "$50, $100, $200", etc. Extract all
      // numeric values and store as a sorted list so Lee can configure
      // multiple alert tiers (floor, GA, lawn) in one wizard run.
      const pi = data.priceAlert.trim().toLowerCase();
      let priceThresholds = [];
      if (!/^(no|skip|nah|nope|none|n)$/.test(pi)) {
        const matches = pi.match(/\d{1,5}(?:\.\d{1,2})?/g) || [];
        priceThresholds = [...new Set(matches.map(n => parseInt(n, 10)).filter(n => n > 0))].sort((a, b) => a - b);
      }
      const priceThreshold = priceThresholds[0] || null; // for back-compat summary display

      let freq = data.frequency.trim().toLowerCase();
      if (freq === 'twice daily') freq = 'every 12 hours';
      if (freq === 'weekly') freq = 'friday at 10am';

      try {
        // Persist the curated list so the next wizard run shows it instead
        // of re-pulling the full Spotify tag list. Also acts as the runtime
        // source-of-truth for the scheduled deterministic dispatch — the
        // scheduler reads `concert_tracker_artists` at fire time, so any
        // edits via `!track add/remove` propagate without re-running the
        // wizard.
        const { setProfile, getProfile: _verifyGetProfile } = require('../user-profiles');
        setProfile(phone, { concert_tracker_artists: artists });
        // Deterministic paper trail — read back and log what actually
        // landed on disk. If setProfile silently no-ops in a future
        // regression, the count won't match and the log will tell us.
        const _verify = _verifyGetProfile(phone);
        const _savedCount = Array.isArray(_verify?.concert_tracker_artists) ? _verify.concert_tracker_artists.length : 0;
        console.log(`[concert-tracker] onComplete save: ${_savedCount}/${artists.length} artists persisted for ${phone.slice(0, 4)}****`);

        // Convert the user's free-text frequency into a real cron rule.
        const parsedFreq = parseFrequency(freq) || parseFrequency('every 6 hours');
        const cronRule = parsedFreq.cron;
        const description = priceThresholds.length > 0
          ? `Concert Price Tracker (alert < $${priceThresholds.join(', < $')})`
          : 'Concert Price Tracker';

        // Dedupe: remove any existing concert-tracker schedules for this
        // user before creating the new one. Without this, every wizard
        // run accumulates a duplicate (we observed 4 stacked dupes for
        // one user). Match by subtype for new-format rows AND by
        // description prefix for legacy rows that lack subtype. Also
        // cancel the in-memory cron entry — removeSchedule only mutates
        // the JSON store; without cancelJob the timer keeps firing for
        // the deleted row until next bot restart.
        const { cancelJob } = require('../scheduler');
        const existing = getUserSchedules(phone);
        for (const s of existing) {
          const isCT =
            s.subtype === 'concert-tracker' ||
            (typeof s.description === 'string' && s.description.startsWith('Concert Price Tracker'));
          if (isCT) {
            cancelJob(s.id);
            removeSchedule(s.id, phone);
            console.log(`[concert-tracker wizard] removed prior schedule #${s.id} for ${phone.slice(0, 4)}****`);
          }
        }

        // Structured payload — the deterministic dispatch reads from
        // here, NOT from `message`. The message field is kept as a
        // human-readable sentinel so the !setup page job list still
        // shows something legible. Critically: nothing in this payload
        // is interpreted as instructions to Claude. The scheduler hits
        // Ticketmaster directly with these values.
        const payload = {
          kind: 'concert-tracker',
          // null = use the user's curated list at fire time, so adds
          // via `!track add` automatically take effect on the next run
          // without another wizard pass. Snapshotting here would freeze
          // the list and is explicitly NOT what we want.
          useCuratedList: true,
          location,
          radiusMiles: 50,
          lookAheadMonths: 3,
          priceThresholds,
          // Cap how many shows we list per artist to keep the DM
          // readable when an artist has many tour dates.
          perArtistLimit: 5,
        };

        const sentinelMessage = `[deterministic concert-tracker job — see payload]`;
        const newSched = addSchedule({
          userId: phone,
          channelId: null,
          message: sentinelMessage,
          cronRule,
          description,
          type: 'dm-task',
          subtype: 'concert-tracker',
          payload,
          timezone: 'America/Los_Angeles',
        });

        // Register the cron in-memory immediately. Without this the
        // schedule only takes effect on the next bot restart, which is
        // confusing UX (the wizard says "set!" but nothing fires for
        // hours). Best-effort — if the scheduler isn't loaded for
        // some reason, the JSON entry will still get picked up at
        // next startup via startAllSchedules().
        try {
          const { registerJob } = require('../scheduler');
          registerJob(newSched, null);
        } catch (e) {
          console.warn(`[concert-tracker wizard] registerJob failed: ${e.message}`);
        }

        const summary = [
          "Concert tracker is set! 🎵",
          '',
          `Artists (${artists.length}): ${artists.slice(0, 8).join(', ')}${artists.length > 8 ? ` +${artists.length - 8} more` : ''}`,
          `📍 Within 50mi of ${location}`,
          `⏰ ${parsedFreq.description || data.frequency.trim()}`,
          priceThresholds.length === 1 ? `💰 Alert under $${priceThresholds[0]}` :
            priceThresholds.length > 1 ? `💰 Alert tiers: $${priceThresholds.join(', $')}` : '',
          '',
          "Edit or toggle anytime in !setup → Scheduled Jobs.",
        ].filter(Boolean).join('\n');
        await message.reply(summary);
      } catch (err) {
        await message.reply(`Failed: ${err.message}`);
      }
    },
  };
}

module.exports = { buildConcertTrackerWizard };
