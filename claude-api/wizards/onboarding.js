/**
 * Conversational onboarding wizard for new Signal users.
 *
 * Triggered when a phone number messages the bot for the first time.
 * Collects name, location, and (optionally) Google Calendar consent
 * via natural chat — no web form required.
 *
 * The wizard runs SILENT (no "Step 1/3" prefixes) so it feels like a
 * normal conversation. After it completes, the user's profile is saved
 * and they get a friendly handoff into the normal chat flow.
 *
 * Calendar OAuth still uses a one-tap web link because OAuth literally
 * cannot happen in a chat — but the user can decline and skip it.
 */

const { setProfile } = require('../user-profiles');

/**
 * @param {string} [targetPhone] - if set (group !onboard), addresses the specific person
 */
function buildOnboardingWizard(targetPhone) {
  return {
    type: 'onboarding',
    silent: true, // No "Step X/Y" prefixes — feels like a normal chat
    steps: [
      {
        key: 'name',
        prompt: targetPhone
          ? `Hey! I'm Bianca — I'm going to get you set up real quick. What should I call you?`
          : "Hey! I don't think we've met yet. I'm Bianca. What should I call you?",
        validate: v => {
          const t = v.trim();
          if (t.length === 0) return "Just type your name.";
          if (t.length > 50) return "That's a long name — give me something shorter to call you.";
          if (/^!/.test(t)) return "That looks like a command. Just tell me your name.";
          return true;
        },
      },
      {
        key: 'location',
        prompt: data => `Nice to meet you, ${data.name}. Where are you based? (city + state, like "Brooklyn NY" or "Austin TX") — this helps me give you weather, local recommendations, and the right timezone.`,
        validate: v => {
          const t = v.trim();
          if (t.length < 2) return "Just give me your city and state.";
          if (/^!/.test(t)) return "That looks like a command. Just tell me your city.";
          return true;
        },
      },
      {
        key: 'wantsCalendar',
        prompt: "Last thing: want me to connect to your Google Calendar so I can help coordinate plans with friends in our group chats? Reply yes or no — totally optional, you can do it later with !setup.",
        validate: v => {
          const t = v.trim().toLowerCase();
          if (/^(yes|y|sure|ok|okay|yep|yeah|please|do it)$/.test(t)) return true;
          if (/^(no|n|nope|nah|skip|later|not now|pass)$/.test(t)) return true;
          return "Just yes or no.";
        },
      },
    ],
    onComplete: async (data, message, state) => {
      const phone = message._signalSenderId || message.author?.id;
      if (!phone) {
        await message.reply("Couldn't figure out your phone number. Try again with !setup.");
        return;
      }

      // Save the collected fields
      setProfile(phone, {
        name: data.name.trim(),
        location: data.location.trim(),
        greeted: true,
        setup_complete: true,
      });

      // Calendar opt-in: send the OAuth link (cannot do OAuth in chat)
      const wantsCal = /^(yes|y|sure|ok|okay|yep|yeah|please|do it)$/i.test(data.wantsCalendar.trim());
      if (wantsCal) {
        const baseUrl = process.env.BOT_PUBLIC_URL || process.env.PUBLIC_URL || 'http://localhost:3400';
        // Get an ephemeral token so the OAuth link actually works
        let oauthUrl = `${baseUrl}/auth/google/calendar/${encodeURIComponent(phone)}`;
        try {
          const http = require('http');
          const tokenRes = await new Promise((resolve, reject) => {
            const body = JSON.stringify({ userId: phone });
            const req = http.request({
              hostname: 'localhost', port: 3400, path: '/internal/setup-token',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Internal-Token': require('../internal-token').getInternalToken(),
                'Content-Length': Buffer.byteLength(body),
              },
            }, res => {
              let data = '';
              res.on('data', c => data += c);
              res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { reject(new Error('bad response')); }
              });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
          });
          if (tokenRes.token) oauthUrl += `?t=${tokenRes.token}`;
        } catch (err) {
          console.warn(`[onboarding] failed to get calendar token: ${err.message}`);
        }
        await message.reply(`Perfect, all set ${data.name.trim()}. Tap this once to connect your calendar (just a quick Google sign-in):\n${oauthUrl}\n\nAfter that, just message me normally for anything you need.`);
      } else {
        await message.reply(`Cool, you're all set ${data.name.trim()}. Just message me anytime for anything. If you change your mind about the calendar later, run \`!setup\`.`);
      }

      // Clear the session so the next message starts a fresh Claude context
      state.sessionId = null;
    },
  };
}

module.exports = { buildOnboardingWizard };
