// planning-context.js — Aggregates planning info for a destination/event
// Used by the trip-planner wizard to build a rich context for Claude

const HOME_BASE = 'Alameda, CA';

/**
 * Build a Claude prompt that gathers planning context for a location or event.
 * Returns a structured prompt string that instructs Claude to use WebSearch/WebFetch
 * to gather all relevant info.
 *
 * @param {string} locationOrEvent - A place name, URL, or event description
 * @param {object} [options] - Optional overrides
 * @param {string} [options.homeBase] - Starting location (default: Alameda, CA)
 * @param {string} [options.dates] - Date range string (e.g. "April 12-14, 2026")
 * @param {boolean} [options.petFriendly] - Whether to check pet-friendliness
 * @returns {string} A prompt string ready to inject into a Claude call
 */
function buildPlanningContext(locationOrEvent, options = {}) {
  const home = options.homeBase || HOME_BASE;
  const dateClause = options.dates
    ? `The trip dates are: ${options.dates}.`
    : 'No specific dates yet — check general seasonal info and upcoming weekend forecasts.';
  const petClause = options.petFriendly !== false
    ? '- **Pet-friendly status**: Can you bring dogs? Any restrictions, pet fees, or nearby dog parks?'
    : '';

  return `You are a travel research assistant. USE WEB SEARCH extensively to gather REAL, CURRENT information about the following destination or event. Do NOT guess — search for actual data.

## Target
${locationOrEvent}

## Research Tasks
Use WebSearch and WebFetch to find ALL of the following. Be specific — include numbers, names, and links.

### 1. Place Details
- What is this place/event? (brief description)
- Address or location
- Hours of operation (if applicable)
- Ratings and reviews summary
- Official website URL

### 2. Pet-Friendly Status
${petClause || '- Skip pet-friendly check (not needed for this trip)'}

### 3. Things to Do Nearby
- Top 5 things to do within 15-20 minutes of the destination
- Mix of: food, activities, sightseeing, nightlife
- Include price ranges where available

### 4. Travel — Distance from ${home}
- **Driving**: Distance in miles, estimated drive time, best route, toll info
- **Flying**: Nearest airports (both ends), typical flight time, airline options
- **Public transit**: Is it reachable by BART/Amtrak/bus? Route and duration if so

### 5. Weather
${dateClause}
- Current/forecasted weather for the destination
- What to pack based on conditions
- Any weather advisories

### 6. Budget Info
- Typical price range for the main activity/venue
- Nearby hotel/Airbnb price range per night
- Average meal cost in the area
- Any free or budget-friendly alternatives

### 7. Parking
- On-site parking availability and cost
- Nearby parking lots/garages with prices
- Street parking situation

### 8. Public Transit at Destination
- Local transit options (bus, subway, rideshare availability)
- Walkability score
- Bike rental or scooter options

## Output Format
Return your findings as a structured summary using this exact format:

**PLACE OVERVIEW**
[description, address, hours, ratings, website]

**PET-FRIENDLY**
[yes/no/partial + details]

**THINGS TO DO NEARBY**
[numbered list with price indicators: $ = cheap, $$ = moderate, $$$ = expensive]

**GETTING THERE FROM ${home.toUpperCase()}**
- Drive: [distance, time, route]
- Fly: [airports, time, airlines]
- Transit: [options]

**WEATHER**
[forecast + packing suggestions]

**BUDGET ESTIMATE**
- Venue/Activity: [range]
- Lodging: [range per night]
- Food: [range per day]
- Estimated total per person: [range]

**PARKING**
[options + costs]

**LOCAL TRANSIT**
[options at destination]

Search thoroughly. Every fact should come from a real source.`;
}

/**
 * Format a distance/travel summary into a compact string
 * @param {object} distanceInfo
 * @param {string} distanceInfo.driveMiles - e.g. "85 miles"
 * @param {string} distanceInfo.driveTime - e.g. "1h 30m"
 * @param {string} distanceInfo.flyTime - e.g. "1h 10m"
 * @param {string} [distanceInfo.transitTime] - e.g. "2h 15m"
 * @returns {string}
 */
function formatDistance(distanceInfo) {
  const parts = [];
  if (distanceInfo.driveMiles && distanceInfo.driveTime) {
    parts.push(`Drive: ${distanceInfo.driveMiles} (${distanceInfo.driveTime})`);
  }
  if (distanceInfo.flyTime) {
    parts.push(`Fly: ~${distanceInfo.flyTime}`);
  }
  if (distanceInfo.transitTime) {
    parts.push(`Transit: ~${distanceInfo.transitTime}`);
  }
  return parts.join(' | ') || 'Distance info unavailable';
}

/**
 * Format weather data into a compact string
 * @param {object} weather
 * @param {string} weather.condition - e.g. "Partly Cloudy"
 * @param {string|number} weather.high - High temp
 * @param {string|number} weather.low - Low temp
 * @param {string} [weather.units] - "F" or "C" (default "F")
 * @param {number} [weather.chanceOfRain] - Percentage
 * @param {string} [weather.packingTips] - What to bring
 * @returns {string}
 */
function formatWeather(weather) {
  const units = weather.units || 'F';
  let result = `${weather.condition}, ${weather.low}-${weather.high} deg${units}`;
  if (weather.chanceOfRain != null && weather.chanceOfRain > 0) {
    result += ` (${weather.chanceOfRain}% rain)`;
  }
  if (weather.packingTips) {
    result += ` — Pack: ${weather.packingTips}`;
  }
  return result;
}

/**
 * Format budget info into a compact string
 * @param {object} budget
 * @param {string} [budget.venue] - e.g. "$20-40"
 * @param {string} [budget.lodging] - e.g. "$120-200/night"
 * @param {string} [budget.food] - e.g. "$30-60/day"
 * @param {string} [budget.totalPerPerson] - e.g. "$200-400"
 * @returns {string}
 */
function formatBudget(budget) {
  const lines = [];
  if (budget.venue) lines.push(`Activity: ${budget.venue}`);
  if (budget.lodging) lines.push(`Stay: ${budget.lodging}`);
  if (budget.food) lines.push(`Food: ${budget.food}`);
  if (budget.totalPerPerson) lines.push(`**Est. total/person: ${budget.totalPerPerson}**`);
  return lines.join('\n') || 'Budget info unavailable';
}

/**
 * Build a compact summary string from raw planning context (for wizard step 2 display)
 * @param {string} locationOrEvent
 * @param {string} claudeResearchOutput - The raw text Claude returned from research
 * @returns {string} Formatted summary for Discord
 */
function formatPlanSummary(locationOrEvent, claudeResearchOutput) {
  // The Claude output is already structured per our prompt format.
  // Truncate if too long for Discord.
  const MAX_LEN = 1800;
  let summary = `**Trip Research: ${locationOrEvent}**\n\n${claudeResearchOutput}`;
  if (summary.length > MAX_LEN) {
    summary = summary.substring(0, MAX_LEN - 20) + '\n\n*(truncated)*';
  }
  return summary;
}

module.exports = {
  buildPlanningContext,
  formatDistance,
  formatWeather,
  formatBudget,
  formatPlanSummary,
  HOME_BASE,
};
