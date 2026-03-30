---
name: hangout-coordinator
description: Coordinate group outings by finding overlapping free time across participants and creating calendar events
triggers:
  - /hangout
  - plan a hangout
  - coordinate outing
  - group plan
  - find time for all of us
  - when can we all go
  - schedule group event
requires:
  - gcal_find_my_free_time
  - gcal_find_meeting_times
  - gcal_list_events
  - gcal_create_event
  - gcal_list_calendars
  - ask_user
---

# Hangout Coordinator Skill

## Overview
Coordinate group outings for Discord users by checking each participant's calendar availability, finding overlapping free windows, presenting options, and creating calendar events for everyone once a time is confirmed. Works especially well in combination with the social-planner skill when a venue/event link has already been extracted.

## Workflow

### Step 1: Gather Participants

Identify who is going. Sources:
- User explicitly lists people: "me, @Alice, and @Bob"
- User says "all of us" — ask who that includes
- Previous context in the conversation (e.g., a group chat)

For each participant, you need their Google Calendar access. If a participant's calendar is not connected, note them as "manual confirm needed."

```
ask_user("Who's coming? List the people (Discord names or emails) so I can check calendars.")
```

Collect:
- **Participant name** (Discord display name)
- **Calendar email** (if different from default — ask if needed)

### Step 2: Gather Venue/Event Context

Check if there is already venue or event info from a previous link extraction (social-planner). If so, use:
- **Venue name and address**
- **Event dates** (if fixed)
- **Travel time from Alameda, CA**
- **Operating hours**

If no venue context exists, ask:
```
ask_user("What are we planning? A specific place/event, or should I help find something?")
```

### Step 3: Determine Time Constraints

Figure out the scheduling window:
- **Date range**: "this weekend", "next two weeks", "in March", etc.
- **Duration needed**: Based on venue type + travel time
  - Local restaurant: 2-3 hours
  - Day trip (1-3 hr drive): 6-10 hours
  - Weekend trip (3+ hr drive or flight): full weekend
- **Time-of-day preference**: Morning, afternoon, evening, all day
- **Fixed event dates**: If the event has specific dates, narrow to those

```
ask_user("When are you thinking? Any date range or preference (weekday evening, weekend, etc.)?")
```

### Step 4: Check Each Participant's Calendar

For the primary user (message sender):
```
gcal_find_my_free_time({
  startDate: "[range start]",
  endDate: "[range end]",
  duration: "[needed duration in minutes]"
})
```

For additional participants with connected calendars, use:
```
gcal_find_meeting_times({
  attendees: ["email1@gmail.com", "email2@gmail.com"],
  startDate: "[range start]",
  endDate: "[range end]",
  duration: "[needed duration in minutes]"
})
```

If gcal_find_meeting_times is not available for a participant, note their availability as "unconfirmed" and flag for manual check.

### Step 5: Find Overlapping Free Windows

From the calendar results:
1. Identify all time slots where ALL connected participants are free
2. Filter by:
   - Time-of-day preference
   - Minimum duration needed (including travel buffer)
   - Weekend vs weekday preference
3. Rank by:
   - Most participants available
   - Best fit for venue hours/event schedule
   - Soonest available date

Select the top 3-5 options.

### Step 6: Present Options

Format for Discord with clear options:

```markdown
## Hangout Plan: [Venue/Event Name]

**Who**: [Participant 1], [Participant 2], [Participant 3]
**Where**: [Venue address]
**Travel**: [X min drive from Alameda]

### Available Times (everyone is free)

1. **Sat, Mar 15 — 11am to 4pm**
   Leave by 10am, arrive ~10:45am, hangout until 3:15pm, home by 4pm

2. **Sun, Mar 16 — 2pm to 8pm**
   Afternoon/evening slot, leave by 1pm

3. **Sat, Mar 22 — 10am to 6pm**
   Full day available for all

### Conflicts
- @Bob is busy Sat Mar 15 after 5pm (dinner plans)
- @Alice has no calendar connected — confirm manually

**Reply with a number to lock it in, or suggest another time.**
```

If some participants have conflicts for all slots:
```markdown
### Partial Availability
These times work for most but not all:

4. **Fri, Mar 14 — 6pm to 10pm** (everyone except @Bob)
5. **Sun, Mar 23 — 12pm to 5pm** (everyone except @Alice)

Want to go without the missing person, or keep looking?
```

### Step 7: Confirm and Create Calendar Events

Once the user picks a time:

```
1. Confirm the selection:
   ask_user("Locking in [Date, Time] for [Venue]. Creating calendar events for everyone. Confirm?")

2. Create calendar event for each participant:
   gcal_create_event({
     summary: "[Hangout/Event Name]",
     location: "[Venue Address]",
     description: "[Venue name]\n[Brief description]\nOrganized via Discord",
     startTime: "[ISO datetime]",
     endTime: "[ISO datetime]",
     attendees: ["email1@gmail.com", "email2@gmail.com", ...],
     reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] }
   })

3. Report success:
   "Calendar event created for [Date] at [Venue]. Invites sent to all participants."
```

### Step 8: Post-Confirmation Summary

```markdown
## Confirmed: [Event Name]
**When**: [Day, Date] [Start Time] - [End Time]
**Where**: [Venue Name], [Address]
**Who**: [All participants]
**Leave by**: [Departure time based on travel]
**Calendar**: Event created — check your calendar for the invite

Have fun!
```

## Error Handling

### Calendar not connected for a participant
```
"I can't check @[Name]'s calendar. Can you ask them if [Date/Time options] work?
Once confirmed, I'll create the event for everyone."
```

### No overlapping free time found
```
"No time works for everyone in [date range]. Options:
1. Expand the date range (look further out)
2. Drop [participant with most conflicts] and find a time for the rest
3. Pick the time that works for the most people

What would you prefer?"
```

### Venue has limited availability
```
"[Venue] is only open [hours/days]. Combining that with everyone's calendars, here are the options that work..."
```

### Event is sold out or past
```
"This event was on [past date] or appears sold out. Want me to:
1. Find similar upcoming events
2. Plan something else at a different venue
```

## Tips for Success

1. **Always add travel buffer** — don't suggest a slot that starts at the exact event time; include drive/transit time.
2. **Prefer weekends** for distant locations unless the user says otherwise.
3. **Group size matters** — the more people, the harder to find overlap. Suggest "most people available" options alongside "everyone available" options.
4. **Re-check before creating** — calendars change. Do a quick availability check right before creating the event.
5. **Include leave-by time** — participants need to know when to depart, not just when the event starts.

## Example Queries

- "Plan a hangout at [Yelp link] with me, @Alice, and @Bob" -> Full workflow: extract venue, check 3 calendars, present times
- "/hangout this weekend" -> Ask who and where, then coordinate
- "When can all of us go to that restaurant?" -> Use previously extracted venue, check calendars
- "Find a time for me and @Alice next week" -> Check two calendars, suggest overlapping slots
- "Schedule the hike for Saturday at 9am" -> Skip to event creation if time is already decided
