---
name: website-tester
description: Test websites by crawling, clicking, filling forms, and reporting issues
triggers:
  - /test-site
  - /test-website
  - test the website
  - check for broken links
  - test the login
  - fill out the form
  - click around
requires:
  - browse_url
  - click
  - type_input
  - fill_form
  - extract_elements
  - wait_for_element
  - wait_for_navigation
  - screenshot
  - get_page_content
  - run_page_script
  - new_tab
  - ask_user
---

# Website Tester Skill

## Overview
Automated website testing including link checking, form testing, login flows, and general exploration. Reports issues found during testing.

## Test Categories

### 1. Link Checker
Find and test all links on a page or site

### 2. Form Tester
Fill and submit forms with test data

### 3. Login Flow Tester
Test authentication flows

### 4. Exploratory Testing
Click around and report observations

### 5. Accessibility Check
Basic accessibility validation

## Workflows

### 1. Broken Link Checker

```javascript
1. browse_url('[target URL]')
2. extract_elements('a[href]', ['href', 'innerText'])
3. For each link:
   - Skip external links (different domain) unless requested
   - Skip mailto:, tel:, javascript: links
   - new_tab(link.href)
   - Check if page loads (wait_for_element('body'))
   - Check for error indicators:
     * 404 text
     * "Page not found"
     * HTTP error status (via page title or content)
   - Record result
   - close_tab()
4. Report all broken links
```

**Output format**:
```markdown
## Link Check Results for [URL]

**Total Links**: 45
**Working**: 42
**Broken**: 3

### Broken Links

| Link Text | URL | Issue |
|-----------|-----|-------|
| Contact Us | /contact | 404 Not Found |
| Old Blog | /blog/2020 | Page Not Found |
| Partner Site | https://old-partner.com | Connection Failed |

### Recommendations
- Update or remove broken links
- Set up redirects for moved pages
- Check external link validity periodically
```

### 2. Form Tester

```javascript
1. browse_url('[form page URL]')
2. Identify form: extract_elements('form', ['action', 'method', 'id'])
3. Identify fields: extract_elements('input, select, textarea', ['name', 'type', 'required', 'id'])
4. Generate test data based on field types:
   - email: test@example.com
   - text: Test Input
   - tel: 555-123-4567
   - number: 42
   - password: TestPass123!
   - select: first option
   - checkbox: check it
   - textarea: Lorem ipsum test content
5. fill_form({ [field selectors]: [test values] })
6. screenshot('form-filled.png')
7. ask_user: "Form filled with test data. Submit it?"
8. If confirmed:
   - click('[type="submit"]') or press_key('Enter')
   - wait_for_navigation()
   - Check for:
     * Success message
     * Validation errors
     * Redirect to thank-you page
     * Server errors
```

**Output format**:
```markdown
## Form Test Results

**Page**: [URL]
**Form**: [form id/name]

### Fields Found
| Field | Type | Required | Test Value |
|-------|------|----------|------------|
| email | email | Yes | test@example.com |
| name | text | Yes | Test User |
| message | textarea | No | Lorem ipsum... |

### Submission Result
✅ Form submitted successfully
- Redirected to: /thank-you
- Success message: "Thanks for your submission"

### Issues Found
- None

### Recommendations
- Consider adding CAPTCHA
- Email field accepts invalid formats
```

### 3. Login Flow Tester

```javascript
1. browse_url('[login page URL]')
2. Identify login form fields
3. Test scenarios:

// Test 1: Empty submission
click('[type="submit"]')
Check for validation errors

// Test 2: Invalid credentials
fill_form({
  'input[type="email"], input[name="username"]': 'invalid@test.com',
  'input[type="password"]': 'wrongpassword'
})
click('[type="submit"]')
wait_for_element('.error, .alert, [role="alert"]')
Check error message

// Test 3: Valid login (requires real credentials)
ask_user: "Do you want to test with real credentials? I'll need you to provide them."

4. Check for:
   - Password field masked
   - HTTPS on login page
   - Error messages don't reveal user existence
   - Account lockout after failed attempts
   - Remember me functionality
   - Forgot password link works
```

**Output format**:
```markdown
## Login Flow Test Results

**Login Page**: [URL]

### Security Checks
| Check | Status | Notes |
|-------|--------|-------|
| HTTPS | ✅ Pass | Secure connection |
| Password Masking | ✅ Pass | Input type="password" |
| Error Messages | ⚠️ Warning | Reveals if email exists |
| Brute Force Protection | ❓ Unknown | Needs extended testing |

### Functionality Tests
| Test | Result |
|------|--------|
| Empty submission | ✅ Shows validation errors |
| Invalid credentials | ✅ Shows error message |
| Forgot password link | ✅ Works |
| Remember me | ✅ Present |

### Issues Found
1. Error message reveals whether email is registered
   - Current: "No account found with this email"
   - Suggested: "Invalid email or password"

### Recommendations
- Implement rate limiting
- Use generic error messages
- Add CAPTCHA after failed attempts
```

### 4. Exploratory Testing

```javascript
1. browse_url('[target URL]')
2. Get page overview: get_page_content()
3. Find all interactive elements:
   - extract_elements('a, button, [onclick], [role="button"]')
4. For each major section:
   - Click navigation items
   - Test dropdowns (hover, then click)
   - Check forms exist
   - Note any JavaScript errors
5. Run page script to check console errors:
   run_page_script(`
     const errors = [];
     window.onerror = (msg) => errors.push(msg);
     return window.__pageErrors || [];
   `)
6. Take screenshots of key pages
7. Report observations
```

**Output format**:
```markdown
## Exploratory Test Report

**Site**: [URL]
**Pages Visited**: 8
**Time**: ~5 minutes

### Site Structure
- Home
  - About
  - Products
    - Product 1
    - Product 2
  - Contact
  - Blog

### Observations

#### Positive
- ✅ Navigation is intuitive
- ✅ Pages load quickly (<2s)
- ✅ Mobile-responsive design
- ✅ Forms have validation

#### Issues Found
| Page | Issue | Severity |
|------|-------|----------|
| /products | Image not loading | Medium |
| /contact | Form submit error | High |
| /blog | Broken layout on scroll | Low |

#### JavaScript Errors
- `/products`: "Cannot read property 'length' of undefined"
- `/contact`: "submitForm is not defined"

### Screenshots
- home.png - Homepage looks good
- products-error.png - Missing image
- contact-error.png - Form error state

### Recommendations
1. Fix form submission on contact page
2. Add fallback for missing product images
3. Debug JavaScript errors in console
```

### 5. Basic Accessibility Check

```javascript
1. browse_url('[target URL]')
2. Run accessibility checks:

run_page_script(`
  const issues = [];

  // Check images for alt text
  document.querySelectorAll('img').forEach(img => {
    if (!img.alt) issues.push('Image missing alt text: ' + img.src);
  });

  // Check form labels
  document.querySelectorAll('input, select, textarea').forEach(input => {
    if (!input.labels?.length && !input.getAttribute('aria-label')) {
      issues.push('Form field missing label: ' + (input.name || input.id));
    }
  });

  // Check heading hierarchy
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  // Check for skipped levels

  // Check link text
  document.querySelectorAll('a').forEach(a => {
    if (a.innerText.toLowerCase() === 'click here' ||
        a.innerText.toLowerCase() === 'read more') {
      issues.push('Non-descriptive link text: ' + a.innerText);
    }
  });

  // Check color contrast (basic)
  // Check keyboard navigation

  return issues;
`)
```

**Output format**:
```markdown
## Accessibility Check Results

**Page**: [URL]
**Standard**: WCAG 2.1 (Basic Checks)

### Summary
| Category | Issues |
|----------|--------|
| Images | 3 missing alt text |
| Forms | 1 unlabeled field |
| Links | 2 non-descriptive |
| Headings | OK |
| Color Contrast | Not checked |

### Detailed Issues

#### Images Missing Alt Text
1. `/images/hero.jpg` - Hero banner
2. `/images/icon1.png` - Feature icon
3. `/images/team/john.jpg` - Team photo

#### Form Labels
1. Search input has no label (use aria-label)

#### Link Text
1. "Click here" → Should describe destination
2. "Read more" → Should be "Read more about [topic]"

### Recommendations
1. Add descriptive alt text to all images
2. Add aria-label to search input
3. Make link text descriptive
4. Run full WAVE or axe accessibility audit
```

## Safety Considerations

1. **Always ask before submitting forms** - Test data might trigger real actions
2. **Don't test login with real credentials** unless explicitly provided
3. **Respect robots.txt** - Don't crawl disallowed paths
4. **Rate limit requests** - Don't overload the server
5. **Don't test sites you don't own** without permission

## Example Queries

- "Test example.com for broken links" → Run link checker
- "Fill out the contact form on /contact" → Form tester
- "Test the login flow on /login" → Login tester
- "Click around example.com and tell me what you find" → Exploratory testing
- "Check if my site is accessible" → Accessibility check
- "Test the checkout process" → Multi-step form/flow testing
