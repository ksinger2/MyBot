module.exports = {
  name: '!commands',
  aliases: [],
  adminOnly: false,
  description: 'List all available commands',
  async run(message, arg, state, ctx) {
    await message.reply(
      `**Available Commands:**\n` +
      `\`!stop\` \`!clear\` \`!compact\` \`!session\` \`!kill\` \`!killall\` \`!restart\` \`!cancel\`\n` +
      `\`/reinit\`\n` +
      `\`!status\` \`!processes\` \`!btw\` \`!cd\` \`!ls\`\n` +
      `\`!startproject\` \`!audit\` \`!name\` \`!identity\`\n` +
      `\`!personality\` \`!personalities\`\n` +
      `\`!tasks\` \`!done\` \`!bugs\` \`!skills\`\n` +
      `\`!plan\` \`!trip\` \`!hangout\` \`!connect\` \`!spotify\`\n` +
      `\`!schedule\` \`!schedules\` \`!unschedule\` \`!autoschedule\`\n` +
      `\`!queue\` \`!queued\` \`!dequeue\`\n` +
      `\`!monitor\` \`!monitors\`\n` +
      `\`!concerts\` \`!prices\` \`!setalert\` \`!alerts\` \`!removealert\` \`!track\` \`!concerttracker\`\n` +
      `\`!product\` \`!search\`\n` +
      `\`!bg\` \`!bgtasks\`\n` +
      `\`!briefing\` \`!weekly\` \`!email\` \`!help\` \`!commands\`\n\n` +
      `Use \`!help\` for detailed descriptions.`
    );
  }
};
