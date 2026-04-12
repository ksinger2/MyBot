module.exports = {
  name: '!profile',
  aliases: [],
  adminOnly: false,
  description: 'View or set user profile',
  async run(message, arg, state, ctx) {
    const { getProfile: _gp, setProfile: _sp, getAllProfiles: _gap } = require('../user-profiles');
    const senderId = message.author?.id || message._signalSenderId;
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
      const p = _gp(targetPhone);
      if (!p) { await message.reply('No profile yet. Use `!setup` to create one.'); return; }
      const lines = [`**Profile for ${targetPhone}:**`];
      if (p.name)     lines.push(`Name: ${p.name}`);
      if (p.location) lines.push(`Location: ${p.location}`);
      if (p.timezone) lines.push(`Timezone: ${p.timezone}`);
      lines.push(`Google Calendar: ${p.gcal_connected ? `${p.gcal_email} ✓` : 'not connected'}`);
      await message.reply(lines.join('\n'));
    }
  }
};
