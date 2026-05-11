const googleAuth = require('./google-auth');
const userTokens = require('./user-tokens');

// Load UUID map for cross-referencing phone↔UUID token lookups
function _loadUuidMap() {
  try {
    const { readEncryptedJson } = require('./encrypted-json');
    const map = readEncryptedJson('/app/data/signal-uuid-phone.json', 'mybot-signal-uuid-phone');
    return (map?.version === 2) ? map : null;
  } catch { return null; }
}
const _uuidMap = _loadUuidMap();

/**
 * Get free/busy availability for multiple Discord users over a date range.
 * @param {string[]} discordUserIds - array of Discord user IDs
 * @param {{ start: string, end: string }} dateRange - ISO datetime strings
 * @returns {Promise<{ userId: string, email: string, busy: { start: string, end: string }[], error?: string }[]>}
 */
async function getAvailability(discordUserIds, dateRange) {
  const results = [];

  for (const userId of discordUserIds) {
    const calendar = await googleAuth.getCalendarClient(userId);
    if (!calendar) {
      results.push({ userId, email: null, busy: [], error: 'not_connected' });
      continue;
    }

    const tokenData = userTokens.getTokenForSignalUser(userId, _uuidMap);
    try {
      const resp = await calendar.freebusy.query({
        requestBody: {
          timeMin: dateRange.start,
          timeMax: dateRange.end,
          items: [{ id: 'primary' }],
        },
      });

      const busy = resp.data.calendars?.primary?.busy || [];
      results.push({
        userId,
        email: tokenData?.email || 'unknown',
        busy: busy.map(b => ({ start: b.start, end: b.end })),
      });
    } catch (err) {
      console.error(`[calendar-coordinator] freebusy error for ${userId}:`, err.message);
      results.push({ userId, email: tokenData?.email, busy: [], error: err.message });
    }
  }

  return results;
}

/**
 * Find overlapping free time windows across multiple users.
 * @param {string[]} discordUserIds
 * @param {{ start: string, end: string }} dateRange - ISO datetime strings
 * @param {number} minDurationMinutes - minimum block length in minutes
 * @returns {Promise<{ start: string, end: string, durationMinutes: number }[]>}
 */
async function findOverlappingFreeTime(discordUserIds, dateRange, minDurationMinutes = 30) {
  const availability = await getAvailability(discordUserIds, dateRange);

  // Collect all busy intervals from all connected users
  const allBusy = [];
  const connectedCount = availability.filter(a => !a.error).length;

  if (connectedCount === 0) return [];

  for (const userAvail of availability) {
    if (userAvail.error) continue;
    for (const block of userAvail.busy) {
      allBusy.push({
        start: new Date(block.start).getTime(),
        end: new Date(block.end).getTime(),
      });
    }
  }

  // Sort busy blocks by start time
  allBusy.sort((a, b) => a.start - b.start);

  // Merge overlapping busy blocks
  const merged = [];
  for (const block of allBusy) {
    if (merged.length === 0 || block.start > merged[merged.length - 1].end) {
      merged.push({ ...block });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, block.end);
    }
  }

  // Find free gaps between merged busy blocks
  const rangeStart = new Date(dateRange.start).getTime();
  const rangeEnd = new Date(dateRange.end).getTime();
  const minDurationMs = minDurationMinutes * 60 * 1000;

  const freeSlots = [];
  let cursor = rangeStart;

  for (const block of merged) {
    if (block.start > cursor) {
      const gap = block.start - cursor;
      if (gap >= minDurationMs) {
        freeSlots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(block.start).toISOString(),
          durationMinutes: Math.round(gap / 60000),
        });
      }
    }
    cursor = Math.max(cursor, block.end);
  }

  // Check trailing free time after last busy block
  if (rangeEnd > cursor) {
    const gap = rangeEnd - cursor;
    if (gap >= minDurationMs) {
      freeSlots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(rangeEnd).toISOString(),
        durationMinutes: Math.round(gap / 60000),
      });
    }
  }

  return freeSlots;
}

/**
 * Create a calendar event on all connected users' calendars.
 * @param {string} title
 * @param {string} description
 * @param {string} startTime - ISO datetime
 * @param {string} endTime - ISO datetime
 * @param {string[]} attendeeDiscordIds - Discord user IDs to create event for
 * @returns {Promise<{ created: { userId: string, email: string, eventId: string }[], failed: { userId: string, error: string }[] }>}
 */
async function createGroupEvent(title, description, startTime, endTime, attendeeDiscordIds) {
  const created = [];
  const failed = [];

  // Gather emails of all connected attendees for the attendees list
  const attendeeEmails = [];
  for (const userId of attendeeDiscordIds) {
    const tokenData = userTokens.getTokenForSignalUser(userId, _uuidMap);
    if (tokenData?.email) {
      attendeeEmails.push(tokenData.email);
    }
  }

  for (const userId of attendeeDiscordIds) {
    const calendar = await googleAuth.getCalendarClient(userId);
    if (!calendar) {
      failed.push({ userId, error: 'not_connected' });
      continue;
    }

    const tokenData = userTokens.getTokenForSignalUser(userId, _uuidMap);

    try {
      const event = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: title,
          description,
          start: { dateTime: startTime },
          end: { dateTime: endTime },
          attendees: attendeeEmails.map(email => ({ email })),
        },
      });

      created.push({
        userId,
        email: tokenData?.email || 'unknown',
        eventId: event.data.id,
      });
    } catch (err) {
      console.error(`[calendar-coordinator] create event error for ${userId}:`, err.message);
      failed.push({ userId, error: err.message });
    }
  }

  return { created, failed };
}

module.exports = { getAvailability, findOverlappingFreeTime, createGroupEvent };
