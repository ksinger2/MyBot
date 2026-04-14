/**
 * google-flights.js — SerpApi Google Flights client
 *
 * Fetches real-time flight prices via SerpApi's Google Flights engine.
 * Free tier: 250 searches/month. Returns structured JSON with prices,
 * airlines, stops, duration.
 *
 * Set SERPAPI_KEY in .env to enable.
 */

const SERPAPI_KEY = process.env.SERPAPI_KEY || '';

/**
 * Search for flights on a specific date.
 * @param {string} origin - Airport code (e.g. "SFO")
 * @param {string} destination - Airport code (e.g. "JFK")
 * @param {string} outboundDate - "YYYY-MM-DD"
 * @param {string} [returnDate] - "YYYY-MM-DD" (omit for one-way)
 * @param {object} [opts] - { airline, maxStops, adults }
 * @returns {object} { flights: [...], priceInsights, lowestPrice }
 */
async function searchFlights(origin, destination, outboundDate, returnDate, opts = {}) {
  if (!SERPAPI_KEY) {
    return { error: 'SERPAPI_KEY not configured. Add it to .env to enable flight price tracking.' };
  }

  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: origin.toUpperCase(),
    arrival_id: destination.toUpperCase(),
    outbound_date: outboundDate,
    api_key: SERPAPI_KEY,
    hl: 'en',
    currency: 'USD',
    adults: String(opts.adults || 1),
  });

  if (returnDate) params.set('return_date', returnDate);
  if (opts.maxStops != null) params.set('stops', String(opts.maxStops));
  // Type 1 = round trip, 2 = one way
  if (!returnDate) params.set('type', '2');

  const url = `https://serpapi.com/search?${params}`;
  console.log(`[flight-prices] Searching: ${origin}→${destination} ${outboundDate}${returnDate ? ' RT ' + returnDate : ' OW'}`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[flight-prices] SerpApi HTTP ${res.status}: ${text.substring(0, 200)}`);
      return { error: `SerpApi returned ${res.status}` };
    }

    const data = await res.json();

    // Extract best flights and other flights
    const bestFlights = (data.best_flights || []).map(mapFlight);
    const otherFlights = (data.other_flights || []).map(mapFlight);
    const allFlights = [...bestFlights, ...otherFlights].sort((a, b) => a.price - b.price);

    // Price insights from Google
    const insights = data.price_insights || null;

    // Find lowest price
    const lowestPrice = allFlights.length > 0 ? allFlights[0].price : null;

    // Filter to Delta if requested
    let filtered = allFlights;
    if (opts.airline) {
      const airlineLower = opts.airline.toLowerCase();
      filtered = allFlights.filter(f =>
        f.airline.toLowerCase().includes(airlineLower) ||
        f.legs.some(l => l.airline.toLowerCase().includes(airlineLower))
      );
    }

    return {
      flights: filtered.slice(0, 10),
      allFlights: allFlights.slice(0, 20),
      priceInsights: insights,
      lowestPrice,
      lowestDelta: filtered.length > 0 ? filtered[0].price : null,
      searchUrl: data.search_metadata?.google_flights_url || null,
    };
  } catch (e) {
    console.error(`[flight-prices] SerpApi error: ${e.message}`);
    return { error: e.message };
  }
}

function mapFlight(flight) {
  const legs = (flight.flights || []).map(leg => ({
    airline: leg.airline || '',
    flightNumber: leg.flight_number || '',
    departure: leg.departure_airport?.name || '',
    departureCode: leg.departure_airport?.id || '',
    departureTime: leg.departure_airport?.time || '',
    arrival: leg.arrival_airport?.name || '',
    arrivalCode: leg.arrival_airport?.id || '',
    arrivalTime: leg.arrival_airport?.time || '',
    duration: leg.duration || 0,
    airplane: leg.airplane || '',
  }));

  return {
    price: flight.price || 0,
    airline: legs[0]?.airline || 'Unknown',
    totalDuration: flight.total_duration || 0,
    stops: (flight.flights?.length || 1) - 1,
    legs,
    type: flight.type || '',
    carbonEmissions: flight.carbon_emissions?.this_flight || null,
  };
}

/**
 * Format flight results as a Signal-friendly message.
 */
function formatFlightResults(result, { origin, destination, date, airline, trend } = {}) {
  if (result.error) return `Flight search error: ${result.error}`;

  const lines = [];
  lines.push(`✈️ **${origin} → ${destination}** (${date})${airline ? ` — ${airline} only` : ''}`);
  lines.push('');

  const flights = (airline ? result.flights : result.allFlights) || [];
  if (flights.length === 0) {
    lines.push('No flights found for this route/date.');
    return lines.join('\n');
  }

  // Top 5 cheapest
  for (const f of flights.slice(0, 5)) {
    const stops = f.stops === 0 ? 'Nonstop' : `${f.stops} stop${f.stops > 1 ? 's' : ''}`;
    const hrs = Math.floor(f.totalDuration / 60);
    const mins = f.totalDuration % 60;
    const duration = `${hrs}h${mins > 0 ? ` ${mins}m` : ''}`;
    const depTime = f.legs[0]?.departureTime || '';
    const arrTime = f.legs[f.legs.length - 1]?.arrivalTime || '';
    lines.push(`- **$${f.price}** — ${f.airline} · ${stops} · ${duration} · ${depTime}→${arrTime}`);
  }

  lines.push('');

  // Price insights from Google
  if (result.priceInsights) {
    const pi = result.priceInsights;
    if (pi.lowest_price) lines.push(`📊 Google says: lowest typical price $${pi.lowest_price}`);
    if (pi.price_level) lines.push(`Price level: ${pi.price_level}`);
  }

  // Trend from our history
  if (trend?.message) {
    lines.push(`📈 ${trend.message}`);
  }

  // Search link
  if (result.searchUrl) {
    lines.push('');
    lines.push(`[View on Google Flights](${result.searchUrl})`);
  }

  return lines.join('\n');
}

module.exports = { searchFlights, formatFlightResults };
