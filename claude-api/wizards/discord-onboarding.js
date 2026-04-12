/**
 * Conversational onboarding wizard for new Discord users.
 *
 * Auto-triggered when a Discord user's first message arrives and they have
 * no completed profile. Collects name, location, device type, and
 * optionally connects Google Calendar.
 *
 * Runs SILENT (no "Step X/Y" prefixes) so it feels like a normal chat.
 */

const { setProfile } = require('../user-profiles');

function buildDiscordOnboardingWizard() {
  return {
    type: 'onboarding',
    silent: true,
    steps: [
      {
        key: 'name',
        prompt: "Hey! I don't think we've met. I'm Bianca. What should I call you?",
        validate: v => {
          const t = v.trim();
          if (t.length === 0) return "Just type your name.";
          if (t.length > 50) return "That's a long name — give me something shorter.";
          if (/^!/.test(t)) return "That looks like a command. Just tell me your name.";
          return true;
        },
      },
      {
        key: 'location',
        prompt: data => `Nice to meet you, ${data.name}. What city are you in? (like "Brooklyn NY" or "Austin TX") — helps me with weather and local recommendations.`,
        validate: v => {
          const t = v.trim();
          if (t.length < 2) return "Just give me your city and state.";
          if (/^!/.test(t)) return "That looks like a command. Just tell me your city.";
          return true;
        },
      },
      {
        key: 'wantsCalendar',
        prompt: "One more thing: want me to connect to your Google Calendar so I can help coordinate plans with friends? (yes or no — totally optional, you can do it later)",
        validate: v => {
          const t = v.trim().toLowerCase();
          if (/^(yes|y|sure|ok|okay|yep|yeah|please|do it)$/.test(t)) return true;
          if (/^(no|n|nope|nah|skip|later|not now|pass)$/.test(t)) return true;
          return "Just yes or no.";
        },
      },
      {
        key: 'device',
        condition: data => /^(yes|y|sure|ok|okay|yep|yeah|please|do it)$/i.test(data.wantsCalendar?.trim()),
        prompt: "Are you on your phone or computer right now? (phone or computer)",
        validate: v => {
          const t = v.trim().toLowerCase();
          if (/^(phone|mobile|iphone|android|cell)$/.test(t)) return true;
          if (/^(computer|pc|desktop|laptop|mac)$/.test(t)) return true;
          return "Just say phone or computer.";
        },
      },
    ],
    onComplete: async (data, message, state) => {
      const userId = message.author?.id;
      if (!userId) {
        await message.reply("Couldn't figure out your Discord ID. Try again later.");
        return;
      }

      setProfile(userId, {
        name: data.name.trim(),
        location: data.location.trim(),
        greeted: true,
        setup_complete: true,
      });

      const wantsCal = /^(yes|y|sure|ok|okay|yep|yeah|please|do it)$/i.test(data.wantsCalendar?.trim());

      if (wantsCal) {
        try {
          const googleAuth = require('../google-auth');
          if (!process.env.GOOGLE_CLIENT_ID) {
            await message.reply(`You're all set, ${data.name.trim()}! (Google Calendar isn't configured on this bot yet, but everything else is ready.)`);
            state.sessionId = null;
            return;
          }
          const authUrl = googleAuth.getAuthUrl(userId);
          const isPhone = /^(phone|mobile|iphone|android|cell)$/i.test(data.device?.trim());

          if (isPhone) {
            // Try to DM them so they can tap it easily
            try {
              await message.author.send(`Tap this to connect your Google Calendar (link expires in 10 min):\n${authUrl}`);
              await message.reply(`You're all set, ${data.name.trim()}! I sent you a DM with the calendar link — tap it when you're ready. Just message me anytime after that.`);
            } catch {
              await message.reply(`You're all set, ${data.name.trim()}! Here's your calendar link — tap it to connect:\n${authUrl}`);
            }
          } else {
            // Desktop — just post it in the channel
            await message.reply(`You're all set, ${data.name.trim()}! Click this to connect your Google Calendar (expires in 10 min):\n${authUrl}\n\nAfter that, just message me normally for anything.`);
          }
        } catch (err) {
          await message.reply(`You're all set, ${data.name.trim()}! Had trouble generating the calendar link right now — run \`!connect\` whenever you're ready to add it.`);
        }
      } else {
        await message.reply(`You're all set, ${data.name.trim()}! Just message me anytime. If you want to connect your calendar later, run \`!connect\`.`);
      }

      state.sessionId = null;
    },
  };
}

module.exports = { buildDiscordOnboardingWizard };
