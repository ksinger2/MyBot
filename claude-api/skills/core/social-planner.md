---
name: social-planner
description: Extract content from social media and location links, then provide planning info with travel details and calendar suggestions
triggers:
  - /plan
  - plan this
  - check this link
  - what is this place
  - tiktok.com
  - instagram.com/p/
  - instagram.com/reel/
  - google.com/maps
  - yelp.com/biz
  - eventbrite.com
requires:
  - WebFetch
  - WebSearch
  - browse_url
  - extract_elements
  - gcal_find_my_free_time
  - gcal_list_events
  - gcal_create_event
---

# Social Planner Skill

## Overview
When a user shares a social media or location link (TikTok, Instagram, Google Maps, Yelp, Eventbrite, etc.), extract the venue/event info and provide actionable planning details: what it is, where it is, travel info from Alameda CA, pet-friendliness, things to do nearby, and suggested calendar times.

## Supported Platforms

1. **TikTok** (tiktok.com) - Videos about places, restaurants, events
2. **Instagram Posts** (instagram.com/p/) - Location-tagged posts
3. **Instagram Reels** (instagram.com/reel/) - Reels about places/events
4. **Google Maps** (google.com/maps, maps.google.com) - Direct place links
5. **Yelp** (yelp.com/biz) - Business listings
6. **Eventbrite** (eventbrite.com) - Events with dates and venues
7. **General URLs** - Any link that references a place or event

## Workflow

### Step 1: Fetch and Extract Page Content

Use WebFetch to load the URL and extract metadata:

```
1. WebFetch(url) to get the page HTML/text
2. Look for:
   - <title> tag
   - og:title, og:description, og:type meta tags
   - Schema.org JSON-LD (Event, Place, Restaurant, LocalBusiness)
   - geo meta tags (place:location:latitude, place:location:longitude)
   - Address patterns in page text
   - Date/time patterns in page text
```

**Platform-specific extraction:**

**TikTok:**
- Video description often contains place name, city, hashtags
- Look for location tags in the video metadata
- Search hashtags for place names

**Instagram:**
- Location tag in post metadata
- Caption text for place names, addresses
- Tagged business accounts

**Google Maps:**
- Place name from URL path or `place/` segment
- Coordinates from `@lat,lng` in URL
- Full address from page content

**Yelp:**
- Business name from URL slug and page title
- Address, phone, hours from structured data
- Category (restaurant, bar, activity, etc.)

**Eventbrite:**
- Event name, date, time from structured data
- Venue name and address
- Ticket price range

### Step 2: Identify the Location/Event

From extracted content, determine:
- **Name**: Place or event name
- **Type**: Restaurant, bar, park, museum, event, concert, etc.
- **Address**: Full street address with city, state, zip
- **Event Dates**: If it's a timed event, when it runs
- **Description**: Brief summary of what it is
- **Price Range**: Cost of entry, food, tickets if available
- **Hours**: Operating hours if it's a business

If the page content is insufficient, do a supplemental WebSearch:
```
WebSearch("[place name] [city] address hours")
```

### Step 3: Get Travel Info from Alameda CA

Use WebSearch or WebFetch to determine:
- **Distance**: Driving distance from Alameda, CA
- **Drive Time**: Estimated drive time (with/without traffic note)
- **Flight**: If 200+ miles, note nearest airport and approximate flight time
- **Transit**: BART/public transit option if in the Bay Area

```
WebSearch("[place name] [address] distance from Alameda CA driving time")
```

### Step 4: Check Pet-Friendliness

Search for pet policy:
```
WebSearch("[place name] pet friendly dog friendly policy")
```

Report one of:
- Pet-friendly (dogs welcome, patio seating, etc.)
- Not pet-friendly
- Unknown / call ahead to confirm

### Step 5: Find Things to Do Nearby

```
WebSearch("things to do near [place name] [city]")
```

List 3-5 nearby activities or attractions, especially if the user is traveling to the area.

### Step 6: Check Calendar and Suggest Times

Use gcal MCP tools to find free time:

```
1. gcal_find_my_free_time for the next 2-4 weeks
2. If it's a timed event, check if the event dates overlap with free time
3. Suggest 2-3 time slots that work
4. Account for travel time (add buffer before/after)
```

For events with fixed dates:
- Check if those specific dates are free
- If not, note the conflict

For places with no fixed date:
- Suggest the next 2-3 free windows (weekend preferred for distant locations)
- Consider drive/flight time when suggesting duration

### Step 7: Present Results

Format for Discord (keep it brief):

```markdown
## [Place/Event Name]
**What**: [Brief description - 1 sentence]
**Where**: [Full address]
**When**: [Event dates OR "Open [hours]"]
**Cost**: [Price range or "Free"]

### Getting There (from Alameda)
- **Drive**: [X miles, ~Y hours]
- **Flight**: [if applicable - nearest airport, ~Z hours]
- **Transit**: [if Bay Area - BART/bus option]

### Good to Know
- **Pet-friendly**: [Yes/No/Call ahead]
- **Nearby**: [2-3 things to do in the area]

### Suggested Times
Based on your calendar:
1. **[Date, Time]** - [note: "free all day" or "after 2pm meeting"]
2. **[Date, Time]** - [note]
3. **[Date, Time]** - [note]

Want me to add any of these to your calendar?
```

## Error Handling

### If URL won't load:
1. Try WebFetch with a different user agent
2. Fall back to WebSearch for the URL to find cached/summarized content
3. Report: "I couldn't load that link directly. Here's what I found about it from search..."

### If location can't be identified:
1. Ask the user: "I can see this is about [topic] but couldn't find a specific location. What place is this about?"
2. Once they clarify, proceed with the planning workflow

### If calendar is unavailable:
1. Skip the calendar suggestion step
2. Note: "I couldn't check your calendar, but here's the planning info. Let me know when you'd like to go and I'll add it."

## Example Queries

- *[User pastes TikTok link]* "omg we should go here" -> Extract the place, provide full planning breakdown
- *[User pastes Yelp link]* -> Extract restaurant info, travel time, suggest dinner dates
- *[User pastes Instagram reel]* "what is this place?" -> Identify and describe the location
- *[User pastes Google Maps link]* "plan a trip here" -> Full planning with calendar
- *[User pastes Eventbrite link]* -> Extract event details, check if dates work on calendar
- "/plan https://www.tiktok.com/..." -> Trigger skill explicitly
