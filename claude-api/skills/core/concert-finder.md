---
name: concert-finder
description: Find concerts and live events for artists near a location
triggers:
  - /concerts
  - find concerts
  - concert dates
  - live shows near
  - events for [artist]
  - when is [artist] playing
requires:
  - browse_url
  - type_input
  - press_key
  - click
  - extract_elements
  - wait_for_element
  - ask_user
---

# Concert Finder Skill

## Overview
Search for upcoming concerts and live events across multiple ticketing platforms, extracting dates, venues, and prices.

## Target Platforms
1. **Ticketmaster** (ticketmaster.com) - Primary source for major artists
2. **Songkick** (songkick.com) - Great for tracking artists
3. **Bandsintown** (bandsintown.com) - Artist-focused event discovery
4. **StubHub** (stubhub.com) - Secondary market for sold-out shows

## Workflow

### Step 1: Parse the Request
Extract from user query:
- **Artist name**: Who they want to see
- **Location**: City, state, or "near me" (ask if unclear)
- **Date range**: This weekend, this month, specific dates (optional)
- **Budget**: Price range (optional)

If location is unclear, use `ask_user`:
```
"What city or area should I search for concerts in?"
```

### Step 2: Search Ticketmaster
```
1. browse_url('https://www.ticketmaster.com')
2. type_input('#search-input', '[artist name]')
3. press_key('Enter')
4. wait_for_element('.event-listing, .search-results')
5. extract_elements('.event-listing', ['innerText', 'href'])
```

**Selectors to try** (may vary):
- Search box: `#search-input`, `input[type="search"]`, `.search-field`
- Results: `.event-listing`, `.event-card`, `.search-result-item`
- Event details: `.event-name`, `.event-date`, `.event-venue`, `.event-price`

### Step 3: Search Songkick
```
1. browse_url('https://www.songkick.com/search?query=[artist]')
2. wait_for_element('.event-listings, .search-results')
3. extract_elements('.event-listings li', ['innerText', 'href'])
```

**Selectors to try**:
- Results: `.event-listings`, `.concert-listing`
- Location filter: Often available on artist page

### Step 4: Search Bandsintown
```
1. browse_url('https://www.bandsintown.com/a/[artist-slug]')
   OR
   browse_url('https://www.bandsintown.com') then search
2. wait_for_element('.event-list, .events')
3. extract_elements('.event-item', ['innerText', 'href'])
```

### Step 5: Filter and Compile Results

From each platform, extract:
- **Date**: When the event is
- **Venue**: Name and location
- **Price**: Range if available
- **Link**: Direct link to tickets

Filter by:
- User's location (city/state match or within radius)
- Date range if specified
- Price range if specified

### Step 6: Present Results

Format output as a table:

```markdown
## Concerts for [Artist] near [Location]

| Date | Venue | City | Price | Tickets |
|------|-------|------|-------|---------|
| Mar 15, 2024 | Madison Square Garden | New York, NY | $89-$299 | [Ticketmaster](link) |
| Mar 18, 2024 | TD Garden | Boston, MA | $75-$250 | [Ticketmaster](link) |
| Mar 22, 2024 | Capital One Arena | Washington, DC | $65-$200 | [StubHub](link) |

### Notes
- Multiple shows may be available for the same venue
- Prices shown are face value; resale may differ
- Some events may be presale only
```

## Error Handling

### If no results found:
1. Try alternative artist name spellings
2. Expand location radius
3. Check if artist is currently touring
4. Report back: "No upcoming shows found for [Artist] near [Location]. They may not be touring currently, or shows haven't been announced yet."

### If site structure changed:
1. Fall back to getting page text and parsing
2. Try alternative selectors
3. Report partial results with source

## Tips for Success

1. **Artist name variations**: Try "Taylor Swift" vs "taylor-swift" for URL slugs
2. **Location matching**: Match on city name, state abbreviation, or venue name
3. **Date parsing**: Normalize dates to consistent format
4. **Price extraction**: Look for patterns like "$X - $Y" or "From $X"
5. **Deduplication**: Same show may appear on multiple platforms

## Example Queries

- "Find Taylor Swift concerts near LA" → Search all platforms, filter for Los Angeles area
- "What shows are in NYC this weekend?" → Search for all events in New York City within next 7 days
- "Concert tickets for Beyonce under $200" → Search with price filter
- "Is Bad Bunny touring near me?" → Need to ask for location first
