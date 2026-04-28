#!/usr/bin/env node
'use strict';

/**
 * CLI utility for reliable calendar access. Uses the bot's own Google OAuth
 * tokens (not Claude's MCP OAuth), so results match what the user actually sees.
 *
 * Usage:
 *   node /app/calendar-cli.js today
 *   node /app/calendar-cli.js week
 *   node /app/calendar-cli.js range --from 2026-04-28 --to 2026-05-05
 *   node /app/calendar-cli.js create --title "Meeting" --datetime "2026-05-01T10:00:00" --duration 60
 */

const SIGNAL_OWNER = process.env.SIGNAL_OWNER_NUMBER;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help') {
    console.log('Usage: node calendar-cli.js <today|week|range|create> [options]');
    console.log('  today                              Show today\'s events');
    console.log('  week                               Show next 7 days');
    console.log('  range --from YYYY-MM-DD --to YYYY-MM-DD');
    console.log('  create --title "X" --datetime "ISO" --duration 60 [--location "X"] [--description "X"]');
    process.exit(0);
  }

  const googleAuth = require('./google-auth');
  const calendar = await googleAuth.getCalendarClient(SIGNAL_OWNER);
  if (!calendar) {
    console.error('Google Calendar not connected. Run !connect to authorize.');
    process.exit(1);
  }

  if (command === 'today') {
    await listEvents(calendar, 0);
  } else if (command === 'week') {
    await listEvents(calendar, 7);
  } else if (command === 'range') {
    const from = getFlag(args, '--from');
    const to = getFlag(args, '--to');
    if (!from || !to) {
      console.error('Usage: range --from YYYY-MM-DD --to YYYY-MM-DD');
      process.exit(1);
    }
    await listEventsRange(calendar, from, to);
  } else if (command === 'create') {
    await createEvent(calendar, args);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

function getFlag(args, flag, defaultValue = null) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return defaultValue;
  return args[idx + 1];
}

async function listEvents(calendar, daysAhead) {
  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setHours(0, 0, 0, 0);

  const timeMax = new Date(timeMin);
  timeMax.setDate(timeMax.getDate() + daysAhead + 1);

  await listEventsRange(calendar, timeMin.toISOString(), timeMax.toISOString());
}

async function listEventsRange(calendar, fromISO, toISO) {
  const timeMin = new Date(fromISO).toISOString();
  const timeMax = new Date(toISO).toISOString();

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });

  const events = res.data.items || [];
  if (events.length === 0) {
    console.log('No events found in this range.');
    return;
  }

  const from = new Date(fromISO).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const to = new Date(toISO).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  console.log(`Events ${from} → ${to} (${events.length} total):\n`);

  let currentDay = '';
  for (const ev of events) {
    const start = ev.start?.dateTime || ev.start?.date;
    const end = ev.end?.dateTime || ev.end?.date;
    const title = ev.summary || '(no title)';
    const location = ev.location ? ` @ ${ev.location}` : '';

    let dayLabel = '';
    let timeStr = '';
    if (ev.start?.dateTime) {
      const d = new Date(ev.start.dateTime);
      dayLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
      const startTime = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
      const endTime = new Date(ev.end.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
      timeStr = `${startTime}–${endTime}`;
    } else {
      dayLabel = ev.start?.date || '';
      timeStr = 'All day';
    }

    if (dayLabel !== currentDay) {
      if (currentDay) console.log('');
      console.log(`📅 ${dayLabel}`);
      currentDay = dayLabel;
    }

    console.log(`  • ${timeStr}: ${title}${location}`);
    if (ev.description) {
      const desc = ev.description.replace(/<[^>]+>/g, '').trim().substring(0, 200);
      if (desc) console.log(`    ${desc}`);
    }
    console.log(`    id: ${ev.id}`);
  }
}

async function createEvent(calendar, args) {
  const title = getFlag(args, '--title');
  const datetime = getFlag(args, '--datetime');
  const duration = parseInt(getFlag(args, '--duration', '60'), 10);
  const location = getFlag(args, '--location');
  const description = getFlag(args, '--description');

  if (!title || !datetime) {
    console.error('Usage: create --title "X" --datetime "ISO" [--duration 60] [--location "X"] [--description "X"]');
    process.exit(1);
  }

  const startTime = new Date(datetime);
  const endTime = new Date(startTime.getTime() + duration * 60 * 1000);

  const event = {
    summary: title,
    start: { dateTime: startTime.toISOString(), timeZone: 'America/Los_Angeles' },
    end: { dateTime: endTime.toISOString(), timeZone: 'America/Los_Angeles' },
  };
  if (location) event.location = location;
  if (description) event.description = description;

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event,
  });

  console.log(`Event created: "${title}"`);
  console.log(`  When: ${startTime.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} (${duration}min)`);
  if (location) console.log(`  Where: ${location}`);
  console.log(`  ID: ${res.data.id}`);
  console.log(`  Link: ${res.data.htmlLink}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
