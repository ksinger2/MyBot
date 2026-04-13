/**
 * Flight Tracker — detects flight images in group chats, creates travel
 * calendar events for all group members, and sends "safe flight" messages.
 *
 * Flow:
 *   1. User shares a flight screenshot/boarding pass in a group chat
 *   2. Claude detects it and outputs [FLIGHT:...] tag with extracted details
 *   3. bot.js calls registerFlight() which:
 *      a. Stores flight in /app/data/flights.json
 *      b. Calls POST /event to add travel block to all group members' calendars
 *      c. Schedules a "have a safe flight" message 2h before departure
 *
 * Flight schema:
 *   {
 *     id: "abc123",
 *     groupId: "group-chat-id",
 *     traveler: "+15551234567",
 *     travelerName: "Karen",
 *     airline: "Delta",
 *     flightNumber: "DL1234",
 *     departureAirport: "SFO",
 *     arrivalAirport: "JFK",
 *     departureTime: "2026-04-15T08:00:00-07:00",
 *     arrivalTime: "2026-04-15T16:30:00-04:00",
 *     safeMsgSent: false,
 *     calendarCreated: false,
 *     createdAt: 1712966400000,
 *   }
 */

const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const { atomicWriteJsonSync } = require('./atomic-write');

const FLIGHTS_FILE = '/app/data/flights.json';
const SAFE_FLIGHT_LEAD_MS = 2 * 60 * 60 * 1000; // 2 hours before departure

// Active node-schedule jobs keyed by flight ID
const _activeJobs = new Map();

// ── Storage ──

function _load() {
  try {
    if (!fs.existsSync(FLIGHTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(FLIGHTS_FILE, 'utf8'));
  } catch (e) {
    console.warn(`[flight-tracker] failed to load: ${e.message}`);
    return [];
  }
}

function _save(flights) {
  atomicWriteJsonSync(FLIGHTS_FILE, flights);
}

function _genId() {
  return require('crypto').randomBytes(6).toString('hex');
}

// ── Core ──

/**
 * Register a detected flight and set up calendar events + safe-flight message.
 *
 * @param {Object} flightInfo - Extracted flight details
 * @param {string} flightInfo.groupId - Group chat ID
 * @param {string} flightInfo.traveler - Phone number of the traveler
 * @param {string} flightInfo.travelerName - Display name
 * @param {string} flightInfo.airline - Airline name
 * @param {string} flightInfo.flightNumber - Flight number
 * @param {string} flightInfo.departureAirport - Departure airport code
 * @param {string} flightInfo.arrivalAirport - Arrival airport code
 * @param {string} flightInfo.departureTime - ISO 8601 departure time
 * @param {string} flightInfo.arrivalTime - ISO 8601 arrival time (optional)
 * @param {string[]} flightInfo.groupMembers - Phone numbers of all group members
 * @param {Function} sendGroupMsg - async (groupId, text) => void
 * @returns {Object} The created flight record
 */
async function registerFlight(flightInfo, sendGroupMsg) {
  const flights = _load();

  // Deduplicate — don't re-register the same flight
  const dup = flights.find(f =>
    f.traveler === flightInfo.traveler &&
    f.flightNumber === flightInfo.flightNumber &&
    f.departureTime === flightInfo.departureTime &&
    !f.safeMsgSent
  );
  if (dup) {
    console.log(`[flight-tracker] duplicate flight ${dup.id} (${dup.flightNumber}) — skipping`);
    return dup;
  }

  const flight = {
    id: _genId(),
    groupId: flightInfo.groupId,
    traveler: flightInfo.traveler,
    travelerName: flightInfo.travelerName || null,
    airline: flightInfo.airline || null,
    flightNumber: flightInfo.flightNumber || null,
    departureAirport: flightInfo.departureAirport || null,
    arrivalAirport: flightInfo.arrivalAirport || null,
    departureTime: flightInfo.departureTime,
    arrivalTime: flightInfo.arrivalTime || null,
    groupMembers: flightInfo.groupMembers || [],
    safeMsgSent: false,
    calendarCreated: false,
    createdAt: Date.now(),
  };

  flights.push(flight);
  _save(flights);
  console.log(`[flight-tracker] registered flight ${flight.id}: ${flight.travelerName || flight.traveler} on ${flight.flightNumber || 'unknown'} (${flight.departureAirport} → ${flight.arrivalAirport})`);

  // Create calendar events for all group members
  await _createCalendarEvents(flight);

  // Schedule safe-flight message
  _scheduleSafeFlightMsg(flight, sendGroupMsg);

  return flight;
}

/**
 * Create "Traveler is traveling" calendar events for all group members.
 */
async function _createCalendarEvents(flight) {
  if (!flight.departureTime) return;

  const title = `${flight.travelerName || 'Friend'} traveling${flight.departureAirport && flight.arrivalAirport ? ` (${flight.departureAirport} → ${flight.arrivalAirport})` : ''}`;
  const description = [
    flight.airline && flight.flightNumber ? `${flight.airline} ${flight.flightNumber}` : null,
    flight.departureAirport ? `From: ${flight.departureAirport}` : null,
    flight.arrivalAirport ? `To: ${flight.arrivalAirport}` : null,
  ].filter(Boolean).join('\n');

  // Duration: use arrival time if available, otherwise default 3 hours
  const depMs = new Date(flight.departureTime).getTime();
  const arrMs = flight.arrivalTime ? new Date(flight.arrivalTime).getTime() : null;
  const durationMin = arrMs ? Math.round((arrMs - depMs) / 60000) : 180;

  try {
    const http = require('http');
    const body = JSON.stringify({
      title,
      datetime: flight.departureTime,
      duration_minutes: durationMin,
      description,
      user_ids: flight.groupMembers.length > 0 ? flight.groupMembers : [flight.traveler],
      chat_id: flight.groupId,
    });

    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: 3400,
        path: '/event',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': process.env.INTERNAL_API_TOKEN || '',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            console.log(`[flight-tracker] calendar events: ${result.created?.length || 0} created, ${result.failed?.length || 0} failed`);
            const flights = _load();
            const f = flights.find(fl => fl.id === flight.id);
            if (f) { f.calendarCreated = true; _save(flights); }
          } catch {}
          resolve();
        });
      });
      req.on('error', (e) => {
        console.warn(`[flight-tracker] calendar event creation failed: ${e.message}`);
        resolve(); // Don't fail the whole flow
      });
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.warn(`[flight-tracker] calendar error: ${e.message}`);
  }
}

/**
 * Schedule a "have a safe flight" message 2 hours before departure.
 */
function _scheduleSafeFlightMsg(flight, sendGroupMsg) {
  if (!flight.departureTime || !sendGroupMsg) return;

  const depTime = new Date(flight.departureTime).getTime();
  const msgTime = new Date(depTime - SAFE_FLIGHT_LEAD_MS);
  const now = Date.now();

  // If the message time has already passed, skip
  if (msgTime.getTime() <= now) {
    console.log(`[flight-tracker] safe-flight time already passed for ${flight.id} — skipping`);
    return;
  }

  // Cancel existing job if any
  if (_activeJobs.has(flight.id)) {
    _activeJobs.get(flight.id).cancel();
  }

  const job = schedule.scheduleJob(msgTime, async () => {
    try {
      const name = flight.travelerName || 'friend';
      const dest = flight.arrivalAirport ? ` to ${flight.arrivalAirport}` : '';
      const flightNum = flight.flightNumber ? ` (${flight.flightNumber})` : '';
      const text = `Have a safe flight${dest}, @${name}! ${flightNum} \u2708\uFE0F`;
      const mentions = flight.traveler ? [{ phone: flight.traveler, name }] : [];
      await sendGroupMsg(flight.groupId, text, { mentions });

      // Mark as sent
      const flights = _load();
      const f = flights.find(fl => fl.id === flight.id);
      if (f) { f.safeMsgSent = true; _save(flights); }
      _activeJobs.delete(flight.id);
      console.log(`[flight-tracker] sent safe-flight message for ${flight.id}`);
    } catch (e) {
      console.warn(`[flight-tracker] failed to send safe-flight msg: ${e.message}`);
    }
  });

  _activeJobs.set(flight.id, job);
  console.log(`[flight-tracker] scheduled safe-flight msg for ${flight.id} at ${msgTime.toISOString()}`);
}

/**
 * On boot, re-schedule safe-flight messages for any pending flights.
 */
function restoreFlightJobs(sendGroupMsg) {
  const flights = _load();
  let restored = 0;
  for (const flight of flights) {
    if (!flight.safeMsgSent && flight.departureTime) {
      const depTime = new Date(flight.departureTime).getTime();
      const msgTime = depTime - SAFE_FLIGHT_LEAD_MS;
      if (msgTime > Date.now()) {
        _scheduleSafeFlightMsg(flight, sendGroupMsg);
        restored++;
      }
    }
  }
  if (restored > 0) {
    console.log(`[flight-tracker] restored ${restored} pending safe-flight job(s)`);
  }
  // Prune old flights (>30 days)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const kept = flights.filter(f => f.createdAt > cutoff);
  if (kept.length < flights.length) {
    _save(kept);
    console.log(`[flight-tracker] pruned ${flights.length - kept.length} old flight(s)`);
  }
}

/**
 * Parse [FLIGHT:...] tag from Claude's response.
 * Format: [FLIGHT: traveler=+phone travelerName=Name airline=Delta flightNumber=DL1234
 *          departureAirport=SFO arrivalAirport=JFK
 *          departureTime=2026-04-15T08:00:00-07:00 arrivalTime=2026-04-15T16:30:00-04:00]
 */
function extractFlightTag(text) {
  const re = /\[FLIGHT:\s*(.+?)\]/gis;
  const flights = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const body = match[1];
    const get = (key) => {
      // Match key=value where value can be quoted or unquoted
      const m = body.match(new RegExp(`${key}=(?:"([^"]+)"|([^\\s\\]]+))`));
      return m ? (m[1] || m[2] || null) : null;
    };
    flights.push({
      traveler: get('traveler'),
      travelerName: get('travelerName'),
      airline: get('airline'),
      flightNumber: get('flightNumber'),
      departureAirport: get('departureAirport'),
      arrivalAirport: get('arrivalAirport'),
      departureTime: get('departureTime'),
      arrivalTime: get('arrivalTime'),
    });
  }
  return flights;
}

/**
 * Strip [FLIGHT:...] tags from text so users don't see them.
 */
function stripFlightTags(text) {
  return text.replace(/\[FLIGHT:\s*.+?\]/gis, '').trim();
}

module.exports = {
  registerFlight,
  restoreFlightJobs,
  extractFlightTag,
  stripFlightTags,
};
