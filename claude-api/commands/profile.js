module.exports = {
  name: '!profile',
  aliases: [],
  adminOnly: false,
  description: 'View or set user profile',
  async run(message, arg, state, ctx) {
    const { getProfile: _gp, setProfile: _sp, getAllProfiles: _gap, getUserData } = require('../user-profiles');
    const senderId = message.author?.id || message._signalSenderId;
    const phone = message._signalSenderId || null;

    // Discord users — no profile system
    if (!phone) {
      await message.reply('Profiles are Signal-only. DM me on Signal to set up your profile!');
      return;
    }

    const { isSignalOwner: _iso3 } = require('../project-permissions');
    const parts = arg.trim().split(/\s+/);

    if (parts[0] === 'all' && _iso3(senderId)) {
      const all = _gap();
      const keys = Object.keys(all);
      if (keys.length === 0) { await message.reply('No profiles saved yet.'); return; }
      const summary = keys.map(k => {
        const p = all[k];
        return `${k}: ${p.name || '(unnamed)'}, ${p.location || 'no location'}${p.gcal_connected ? ', cal ✓' : ''}`;
      }).join('\n');
      await message.reply(`**All profiles:**\n${summary}`);
      return;
    }

    let targetPhone = senderId;
    let rest = parts;
    if (_iso3(senderId) && parts[0] && parts[0].startsWith('+') && parts[1] === 'set') {
      targetPhone = parts[0];
      rest = parts.slice(1);
    }

    if (rest[0] === 'set') {
      const field = rest[1];
      const value = rest.slice(2).join(' ');
      const allowed = ['name', 'location', 'timezone'];
      if (!allowed.includes(field)) {
        await message.reply(`Can set: ${allowed.join(', ')}`);
        return;
      }
      if (!value) { await message.reply(`Usage: !profile set ${field} <value>`); return; }
      _sp(targetPhone, { [field]: value });
      await message.reply(`Profile updated: ${field} = ${value}`);
    } else {
      const data = getUserData(targetPhone);
      if (!data) { await message.reply('No profile found. Send me a message on Signal to start onboarding!'); return; }
      const lines = [];
      lines.push('**Your Profile**');
      lines.push(`Name: ${data.name || '(not set)'}`);
      lines.push(`Location: ${data.location || '(not set)'}`);
      lines.push(`Timezone: ${data.timezone || '(not set)'}`);
      lines.push(`Calendar: ${data.gcal_connected ? `connected (${data.gcal_email})` : 'not connected'}`);
      if (data.preferences && data.preferences.length > 0) {
        lines.push(`\n**Preferences** (${data.preferences.length}):`);
        data.preferences.forEach((p, i) => {
          lines.push(`  ${i + 1}. ${p.fact} (${p.source}, ${new Date(p.learnedAt).toLocaleDateString()})`);
        });
      } else {
        lines.push('\nNo preferences stored yet. I\'ll learn about you as we chat!');
      }
      await message.reply(lines.join('\n'));
    }
  }
};
