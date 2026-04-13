/**
 * Parse human-readable frequency strings into cron expressions.
 *
 * Supports: raw cron, "every N hours/minutes", "daily at TIME",
 * "weekdays at TIME", "weekends at TIME", "DAYNAME at TIME", "at TIME".
 *
 * Returns { cron, description } or null if unparseable.
 */

function parseFrequency(input) {
  const s = input.trim().toLowerCase();

  // Raw cron expression (5 fields)
  if (/^[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+$/.test(s)) {
    return { cron: s, description: `Cron: ${s}` };
  }

  // "every N hours" or "every N minutes"
  const intervalMatch = s.match(/^every\s+(\d+)\s+(hour|minute|min)s?$/);
  if (intervalMatch) {
    const n = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    if (unit === 'hour') {
      return { cron: `0 */${n} * * *`, description: `Every ${n} hour(s)` };
    } else {
      return { cron: `*/${n} * * * *`, description: `Every ${n} minute(s)` };
    }
  }

  // Parse time from strings like "at 9am", "at 8:30pm", "at 14:00"
  function parseTime(str) {
    const timeMatch = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!timeMatch) return null;
    let hour = parseInt(timeMatch[1], 10);
    const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  // "daily at TIME"
  const dailyMatch = s.match(/^daily\s+at\s+(.+)$/);
  if (dailyMatch) {
    const time = parseTime(dailyMatch[1]);
    if (time) return { cron: `${time.minute} ${time.hour} * * *`, description: `Daily at ${dailyMatch[1].trim()}` };
  }

  // "weekdays at TIME"
  const weekdayMatch = s.match(/^weekdays?\s+at\s+(.+)$/);
  if (weekdayMatch) {
    const time = parseTime(weekdayMatch[1]);
    if (time) return { cron: `${time.minute} ${time.hour} * * 1-5`, description: `Weekdays at ${weekdayMatch[1].trim()}` };
  }

  // "weekends at TIME"
  const weekendMatch = s.match(/^weekends?\s+at\s+(.+)$/);
  if (weekendMatch) {
    const time = parseTime(weekendMatch[1]);
    if (time) return { cron: `${time.minute} ${time.hour} * * 0,6`, description: `Weekends at ${weekendMatch[1].trim()}` };
  }

  // "DAYNAME at TIME" (e.g. "monday at 10am", "tuesday at 3:30pm")
  const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const dayMatch = s.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\s+at\s+(.+)$/);
  if (dayMatch) {
    const dayNum = days[dayMatch[1]];
    const time = parseTime(dayMatch[2]);
    if (time) return { cron: `${time.minute} ${time.hour} * * ${dayNum}`, description: `${dayMatch[1].charAt(0).toUpperCase() + dayMatch[1].slice(1)}s at ${dayMatch[2].trim()}` };
  }

  // "at TIME" (assume daily)
  const atMatch = s.match(/^at\s+(.+)$/);
  if (atMatch) {
    const time = parseTime(atMatch[1]);
    if (time) return { cron: `${time.minute} ${time.hour} * * *`, description: `Daily at ${atMatch[1].trim()}` };
  }

  return null;
}

/**
 * Validate that a cron rule doesn't fire more often than every 5 minutes.
 * Returns true if the interval is safe, false if too frequent.
 */
function validateMinInterval(cronRule) {
  const parts = cronRule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour] = parts;
  // Reject every-minute patterns
  if (minute === '*' && hour === '*') return false;
  // Reject */1 through */4 in minutes field
  const minuteStep = minute.match(/^\*\/(\d+)$/);
  if (minuteStep && parseInt(minuteStep[1], 10) < 5) return false;
  // Reject explicit per-minute patterns like "1,2,3,4,5" with >12 entries (fires 12+ times/hour)
  if (minute.includes(',') && minute.split(',').length > 12) return false;
  return true;
}

module.exports = { parseFrequency, validateMinInterval };
