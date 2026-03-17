---
name: gmail-browser
description: Compose, send, and manage emails through Gmail web interface
triggers:
  - /gmail
  - /email
  - send email
  - check email
  - check my inbox
  - reply to email
  - compose email
  - email [person] about
requires:
  - browse_url
  - type_input
  - press_key
  - click
  - extract_elements
  - wait_for_element
  - wait_for_text
  - save_session
  - restore_session
  - ask_user
---

# Gmail Browser Skill

## Overview
Interact with Gmail through the web interface to compose, send, read, and manage emails. Always requires confirmation before sending.

## SAFETY RULES - CRITICAL

1. **NEVER send an email without explicit user confirmation**
2. **Always show email preview before sending**
3. **Ask for confirmation on any destructive action (delete, archive)**
4. **Do not access emails unless user requests it**
5. **Respect privacy - summarize, don't expose full content unnecessarily**

## Session Management

### First-time setup
```
1. browse_url('https://mail.google.com')
2. Ask user: "Please log into your Gmail account. Tell me when you're done."
3. wait_for_element('div[role="navigation"]')  // Gmail loaded
4. save_session('gmail')
```

### Subsequent uses
```
1. restore_session('gmail')
2. browse_url('https://mail.google.com')
3. wait_for_element('div[role="navigation"]')
4. Verify inbox loads
```

## Gmail Selectors Reference

**Note**: Gmail uses dynamic class names. These are stable selectors:

### Navigation
- Compose button: `div[gh="cm"]`, `[role="button"][tabindex="0"]` (first one)
- Inbox: `a[href*="#inbox"]`
- Sent: `a[href*="#sent"]`
- Drafts: `a[href*="#drafts"]`

### Compose Window
- To field: `input[name="to"]`, `[aria-label="To"]`
- CC field: `[aria-label="Cc"]`
- BCC field: `[aria-label="Bcc"]`
- Subject: `input[name="subjectbox"]`, `[aria-label="Subject"]`
- Body: `div[aria-label="Message Body"]`, `div[role="textbox"]`
- Send button: `div[aria-label*="Send"]`, `[data-tooltip*="Send"]`
- Discard: `div[aria-label="Discard draft"]`

### Email List
- Email rows: `tr.zA`, `div[role="row"]`
- Unread emails: `tr.zE`, `.zA.zE`
- Email subject: `.bog`, `span.bqe`
- Email sender: `.yP`, `.zF`
- Email snippet: `.y2`

### Email View
- Subject: `h2[data-thread-perm-id]`, `.hP`
- Sender: `.gD`
- Body: `.a3s.aiL`
- Reply button: `[aria-label="Reply"]`
- Forward button: `[aria-label="Forward"]`

## Workflows

### 1. Compose and Send Email

```
1. restore_session('gmail')
2. browse_url('https://mail.google.com')
3. wait_for_element('div[gh="cm"]')
4. click('div[gh="cm"]')  // Compose
5. wait_for_element('input[name="to"]')
6. type_input('input[name="to"]', '[recipient email]')
7. type_input('input[name="subjectbox"]', '[subject]')
8. type_input('div[aria-label="Message Body"]', '[body]')

// ALWAYS confirm before sending
9. ask_user:
   "Ready to send this email?

   To: [recipient]
   Subject: [subject]

   ---
   [body preview]
   ---

   Send this email?"

10. If confirmed:
    click('div[aria-label*="Send"]')
    wait_for_text('Message sent')
```

### 2. Check Inbox

```
1. restore_session('gmail')
2. browse_url('https://mail.google.com/#inbox')
3. wait_for_element('tr.zA')
4. extract_elements('tr.zA', ['innerText'])
```

**Parse each row for**:
- Sender name
- Subject line
- Snippet/preview
- Date/time
- Unread status (has class `zE`)
- Has attachment (look for paperclip icon)

### 3. Search Emails

```
1. browse_url('https://mail.google.com/#search/[query]')
   OR
2. type_input('input[aria-label="Search mail"]', '[query]')
3. press_key('Enter')
4. wait_for_element('tr.zA')
5. extract_elements('tr.zA', ['innerText'])
```

**Search operators**:
- `from:person@email.com` - From specific sender
- `to:person@email.com` - To specific recipient
- `subject:keyword` - Subject contains
- `is:unread` - Unread only
- `has:attachment` - Has attachments
- `after:2024/01/01` - After date
- `before:2024/12/31` - Before date

### 4. Read Specific Email

```
1. Search or navigate to inbox
2. click('tr.zA:nth-child(N)')  // Click Nth email
   OR click email matching subject/sender
3. wait_for_element('.a3s.aiL')  // Email body
4. Extract:
   - Subject: get_element_text('h2[data-thread-perm-id]')
   - Sender: get_element_text('.gD')
   - Body: get_element_text('.a3s.aiL')
```

### 5. Reply to Email

```
1. Open the email (workflow #4)
2. click('[aria-label="Reply"]')
3. wait_for_element('div[aria-label="Message Body"]')
4. type_input('div[aria-label="Message Body"]', '[reply text]')

// ALWAYS confirm
5. ask_user:
   "Reply to [sender]?

   ---
   [reply preview]
   ---

   Send this reply?"

6. If confirmed:
   click('div[aria-label*="Send"]')
```

### 6. Forward Email

```
1. Open the email
2. click('[aria-label="Forward"]')
3. wait_for_element('input[name="to"]')
4. type_input('input[name="to"]', '[forward to email]')
5. Optionally add message above forwarded content

// ALWAYS confirm
6. ask_user: "Forward this email to [recipient]?"

7. If confirmed:
   click('div[aria-label*="Send"]')
```

### 7. Delete/Archive Email

```
1. Open the email
2. ask_user: "Delete this email from [sender] about '[subject]'?"
3. If confirmed:
   click('[aria-label="Delete"]')  // or Archive
```

## Output Formats

### Inbox Summary
```markdown
## Gmail Inbox

**Unread**: 5 new emails

| From | Subject | Time |
|------|---------|------|
| 📬 John Smith | Meeting tomorrow | 10:30 AM |
| 📬 Amazon | Your order shipped | 9:15 AM |
| ✉️ Mom | Dinner this weekend? | Yesterday |
| ✉️ Newsletter | Weekly digest | Yesterday |

📬 = Unread  ✉️ = Read

Would you like to read any of these?
```

### Email View
```markdown
## Email from [Sender]

**Subject**: [Subject line]
**Date**: [Date and time]
**To**: [Recipients]

---

[Email body - summarized if long]

---

**Actions**: Reply | Forward | Archive | Delete
```

### Compose Preview
```markdown
## Email Draft

**To**: john@example.com
**Subject**: Meeting Follow-up

---

Hi John,

Thanks for meeting today. Here are the action items we discussed:
1. ...
2. ...

Let me know if you have questions.

Best,
[User]

---

Ready to send?
```

## Error Handling

### Not logged in
```
"You're not logged into Gmail. Would you like to log in now?
I'll open Gmail and you can sign in. Once done, I'll save the session."
```

### Email not found
```
"I couldn't find an email matching '[search term]'. Try:
- Checking the spelling
- Using a different search term
- Looking in Spam or Trash folders"
```

### Send failed
```
"The email couldn't be sent. This might be because:
- Invalid recipient address
- Network issue
- Gmail is temporarily unavailable

Your draft has been saved. Would you like to try again?"
```

## Example Queries

- "Send an email to john@example.com about the meeting" → Compose with confirmation
- "Check my inbox" → Show recent emails
- "Read the email from Amazon" → Open and display
- "Reply saying 'Thanks, I'll be there'" → Reply with confirmation
- "Search for emails from Mom" → Search and list results
- "Delete the newsletter email" → Confirm then delete
- "Do I have any unread emails?" → Quick inbox check
