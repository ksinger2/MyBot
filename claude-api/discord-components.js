// discord-components.js — Helper module for Discord interactive components
// Provides builders for buttons, select menus, embeds, and interaction routing
// for the trip/outing planning feature.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

// Custom ID prefix for all plan-related interactions
const PREFIX = 'plan';

// --- Builders ---

/**
 * Create an ActionRow with buttons for each time slot.
 * Each button gets a custom ID like: plan:timeslot:SLOT_INDEX
 *
 * @param {Array<{label: string, value: string, emoji?: string}>} slots
 * @param {string} [eventId] - Optional event ID for routing
 * @returns {ActionRowBuilder}
 */
function createTimeSlotButtons(slots, eventId = 'default') {
  const maxButtons = 5; // Discord limit per row
  const row = new ActionRowBuilder();

  const slotSubset = slots.slice(0, maxButtons);
  for (let i = 0; i < slotSubset.length; i++) {
    const slot = slotSubset[i];
    const button = new ButtonBuilder()
      .setCustomId(`${PREFIX}:timeslot:${eventId}:${i}`)
      .setLabel(slot.label)
      .setStyle(ButtonStyle.Primary);

    if (slot.emoji) {
      button.setEmoji(slot.emoji);
    }

    row.addComponents(button);
  }

  return row;
}

/**
 * Create a rich embed summarizing a trip/outing plan.
 *
 * @param {object} planData
 * @param {string} planData.title - Trip title (e.g. "Yosemite Weekend")
 * @param {string} [planData.description] - Short description
 * @param {string} [planData.destination] - Destination name
 * @param {string} [planData.dates] - Date range
 * @param {string} [planData.travelTime] - e.g. "3h 30m drive"
 * @param {string} [planData.weather] - Weather summary
 * @param {string} [planData.cost] - Estimated cost per person
 * @param {string} [planData.groupSize] - e.g. "4 people"
 * @param {string} [planData.highlights] - Key activities
 * @param {string} [planData.url] - Link to venue/event
 * @param {string} [planData.imageUrl] - Thumbnail image URL
 * @param {string} [planData.footerText] - Footer text
 * @returns {EmbedBuilder}
 */
function createPlanSummaryEmbed(planData) {
  const embed = new EmbedBuilder()
    .setTitle(planData.title || 'Trip Plan')
    .setColor(0x5865f2); // Discord blurple

  if (planData.description) {
    embed.setDescription(planData.description);
  }

  const fields = [];

  if (planData.destination) {
    fields.push({ name: 'Destination', value: planData.destination, inline: true });
  }
  if (planData.dates) {
    fields.push({ name: 'Dates', value: planData.dates, inline: true });
  }
  if (planData.groupSize) {
    fields.push({ name: 'Group', value: planData.groupSize, inline: true });
  }
  if (planData.travelTime) {
    fields.push({ name: 'Travel', value: planData.travelTime, inline: true });
  }
  if (planData.weather) {
    fields.push({ name: 'Weather', value: planData.weather, inline: true });
  }
  if (planData.cost) {
    fields.push({ name: 'Est. Cost/Person', value: planData.cost, inline: true });
  }
  if (planData.highlights) {
    fields.push({ name: 'Highlights', value: planData.highlights, inline: false });
  }

  if (fields.length > 0) {
    embed.addFields(fields);
  }

  if (planData.url) {
    embed.setURL(planData.url);
  }
  if (planData.imageUrl) {
    embed.setThumbnail(planData.imageUrl);
  }
  if (planData.footerText) {
    embed.setFooter({ text: planData.footerText });
  } else {
    embed.setFooter({ text: 'Use the buttons below to take action' });
  }

  embed.setTimestamp();

  return embed;
}

/**
 * Create a row of quick-action buttons for a plan.
 *
 * @param {object} [options]
 * @param {string} [options.eventId] - Event identifier for custom ID routing
 * @param {boolean} [options.showCalendar] - Show "Add to Calendar" button (default true)
 * @param {boolean} [options.showShare] - Show "Share with Friends" button (default true)
 * @param {boolean} [options.showDirections] - Show "Get Directions" button (default true)
 * @param {boolean} [options.showMoreInfo] - Show "More Info" button (default true)
 * @returns {ActionRowBuilder}
 */
function createQuickActions(options = {}) {
  const eventId = options.eventId || 'default';
  const row = new ActionRowBuilder();

  if (options.showCalendar !== false) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:calendar:${eventId}`)
        .setLabel('Add to Calendar')
        .setStyle(ButtonStyle.Success)
        .setEmoji('📅')
    );
  }

  if (options.showShare !== false) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:share:${eventId}`)
        .setLabel('Share with Friends')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📤')
    );
  }

  if (options.showDirections !== false) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:directions:${eventId}`)
        .setLabel('Get Directions')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🗺️')
    );
  }

  if (options.showMoreInfo !== false) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:moreinfo:${eventId}`)
        .setLabel('More Info')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('ℹ️')
    );
  }

  return row;
}

/**
 * Create a voting message with buttons for each option.
 * Useful for group decisions (e.g. "Which weekend works?").
 *
 * @param {string} question - The question to vote on
 * @param {Array<{label: string, value: string, emoji?: string}>} options - Vote options
 * @param {string} [eventId] - Event identifier
 * @returns {{ content: string, components: ActionRowBuilder[] }}
 */
function createVotingMessage(question, options, eventId = 'default') {
  const rows = [];
  // Discord allows max 5 buttons per row, max 5 rows
  for (let rowIdx = 0; rowIdx < Math.ceil(options.length / 5) && rowIdx < 5; rowIdx++) {
    const row = new ActionRowBuilder();
    const chunk = options.slice(rowIdx * 5, (rowIdx + 1) * 5);

    for (let i = 0; i < chunk.length; i++) {
      const opt = chunk[i];
      const globalIdx = rowIdx * 5 + i;
      const button = new ButtonBuilder()
        .setCustomId(`${PREFIX}:vote:${eventId}:${globalIdx}`)
        .setLabel(opt.label)
        .setStyle(ButtonStyle.Primary);

      if (opt.emoji) {
        button.setEmoji(opt.emoji);
      }

      row.addComponents(button);
    }

    rows.push(row);
  }

  return {
    content: `**Vote:** ${question}`,
    components: rows,
  };
}

/**
 * Create a select menu for choosing from a list of options.
 *
 * @param {string} placeholder - Placeholder text
 * @param {Array<{label: string, value: string, description?: string, emoji?: string}>} options
 * @param {string} menuId - Custom ID suffix
 * @returns {ActionRowBuilder}
 */
function createSelectMenu(placeholder, options, menuId = 'select') {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:${menuId}`)
    .setPlaceholder(placeholder)
    .addOptions(
      options.slice(0, 25).map((opt) => {
        const option = { label: opt.label, value: opt.value };
        if (opt.description) option.description = opt.description;
        if (opt.emoji) option.emoji = opt.emoji;
        return option;
      })
    );

  return new ActionRowBuilder().addComponents(select);
}

// --- Interaction Handler ---

// In-memory vote tallies: eventId -> { optionIndex -> Set<userId> }
const voteTallies = new Map();

/**
 * Handle a button or select menu interaction that matches the plan prefix.
 * Call this from your main interactionCreate handler.
 *
 * @param {import('discord.js').Interaction} interaction - The interaction event
 * @returns {boolean} true if this interaction was handled, false if not ours
 */
async function handleComponentInteraction(interaction) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return false;

  const customId = interaction.customId;
  if (!customId.startsWith(`${PREFIX}:`)) return false;

  const parts = customId.split(':');
  const action = parts[1];
  const eventId = parts[2] || 'default';

  try {
    switch (action) {
      case 'timeslot':
        await handleTimeslotClick(interaction, eventId, parts[3]);
        break;

      case 'calendar':
        await handleCalendarClick(interaction, eventId);
        break;

      case 'share':
        await handleShareClick(interaction, eventId);
        break;

      case 'directions':
        await handleDirectionsClick(interaction, eventId);
        break;

      case 'moreinfo':
        await handleMoreInfoClick(interaction, eventId);
        break;

      case 'vote':
        await handleVoteClick(interaction, eventId, parts[3]);
        break;

      default:
        await interaction.reply({ content: 'Unknown action.', ephemeral: true });
        break;
    }
  } catch (err) {
    console.error(`Component interaction error (${action}):`, err.message);
    const replyFn = interaction.replied || interaction.deferred
      ? interaction.followUp.bind(interaction)
      : interaction.reply.bind(interaction);
    await replyFn({ content: 'Something went wrong handling that action.', ephemeral: true }).catch(() => {});
  }

  return true;
}

// --- Action Handlers ---

async function handleTimeslotClick(interaction, eventId, slotIndex) {
  await interaction.reply({
    content: `You picked time slot **#${parseInt(slotIndex, 10) + 1}**. I'll use this for the plan.`,
    ephemeral: true,
  });
}

async function handleCalendarClick(interaction, eventId) {
  // Defer since calendar creation may take a moment
  await interaction.reply({
    content:
      'To create a calendar event, type something like:\n' +
      '`create a Google Calendar event for this trip`\n' +
      'and I\'ll set it up with all the details.',
    ephemeral: true,
  });
}

async function handleShareClick(interaction, eventId) {
  await interaction.reply({
    content:
      'To share this plan, @mention the people you want to send it to and say:\n' +
      '`share this plan with @friend1 @friend2`',
    ephemeral: true,
  });
}

async function handleDirectionsClick(interaction, eventId) {
  await interaction.reply({
    content:
      'Ask me for directions! Say something like:\n' +
      '`how do I get to [destination] from Alameda?`\n' +
      'and I\'ll look up the best routes.',
    ephemeral: true,
  });
}

async function handleMoreInfoClick(interaction, eventId) {
  await interaction.reply({
    content:
      'Want more details? Ask me anything:\n' +
      '- "What\'s the weather like there?"\n' +
      '- "What restaurants are nearby?"\n' +
      '- "Is it pet-friendly?"',
    ephemeral: true,
  });
}

async function handleVoteClick(interaction, eventId, optionIndex) {
  const idx = parseInt(optionIndex, 10);
  const userId = interaction.user.id;

  // Initialize tally for this event if needed
  if (!voteTallies.has(eventId)) {
    voteTallies.set(eventId, new Map());
  }
  const tally = voteTallies.get(eventId);

  // Remove user's previous vote (if any) to allow vote switching
  for (const [key, voters] of tally.entries()) {
    voters.delete(userId);
  }

  // Record new vote
  if (!tally.has(idx)) {
    tally.set(idx, new Set());
  }
  tally.get(idx).add(userId);

  // Build vote count summary
  const counts = [];
  for (const [optIdx, voters] of [...tally.entries()].sort((a, b) => a[0] - b[0])) {
    counts.push(`Option ${optIdx + 1}: ${voters.size} vote(s)`);
  }

  await interaction.reply({
    content: `Vote recorded! Current tally:\n${counts.join('\n')}`,
    ephemeral: false,
  });
}

// --- Exports ---

module.exports = {
  createTimeSlotButtons,
  createPlanSummaryEmbed,
  createQuickActions,
  createVotingMessage,
  createSelectMenu,
  handleComponentInteraction,
  PREFIX,
};
