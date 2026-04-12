# Bug List — Automated Bug Discovery & Fix Loop

Systematically test the application using Playwright browser automation, find all bugs, and optionally fix them.

## Phase 1: Setup
1. Read CLAUDE.md for how to build and run the project
2. Check if the dev server is already running: `curl -sf http://localhost:3000/ > /dev/null && echo "running"`
3. If not running, start it with PM2: `PM2_HOME=/home/node/.claude/.pm2 pm2 start "npm run dev" --name app-dev`
4. Wait for it to be accessible (retry curl every 2s, up to 30s)

## Phase 2: Desktop Crawl
Use Playwright MCP tools to systematically test:
1. Navigate to the app's main URL (usually http://localhost:3000)
2. Take a screenshot of the landing page
3. Find all navigation links, buttons, and interactive elements
4. Visit every page/route in the app
5. On each page:
   - Take a screenshot
   - Check for console errors (inject script: `window.__errors = []; window.onerror = (m) => __errors.push(m)`)
   - Check for broken images (img elements with naturalWidth === 0)
   - Test interactive elements (buttons, forms, dropdowns)
   - Note any visual issues (overflow, alignment, z-index problems, missing content)
   - Check for accessibility issues (missing alt text, color contrast, keyboard navigation)

## Phase 3: Mobile Testing
Repeat Phase 2 with mobile viewports using Playwright's viewport settings:
- **iPhone 14**: 390x844 viewport
- **Pixel 7**: 412x915 viewport
Note responsive design issues: elements overlapping, text too small, touch targets too small, horizontal scroll.

## Phase 4: Bug Report
Create a prioritized bug list in this format:

```
# Bug Report — [Project Name] — [Date]

## Critical (app crashes, data loss, security)
1. [Page/Screen] — Description — Screenshot: [path]

## High (feature broken, blocks usage)
1. [Page/Screen] — Description — Screenshot: [path]

## Medium (visual bugs, minor functionality)
1. [Page/Screen] — Description — Screenshot: [path]

## Low (polish, cosmetic)
1. [Page/Screen] — Description — Screenshot: [path]
```

Save as `BUG-REPORT.md` in the project root.

## Phase 5: Auto-Fix Loop (if user requests fixes)
When told to fix the bugs:
1. Start with Critical severity, then High, Medium, Low
2. For each bug:
   a. Fix the code
   b. Restart the dev server: `PM2_HOME=/home/node/.claude/.pm2 pm2 restart app-dev`
   c. Wait for server to be ready (curl health check)
   d. Navigate back to the affected page with Playwright
   e. Take a new screenshot to verify the fix
   f. If fixed, mark as resolved and move to next bug
   g. If not fixed, try a different approach (max 3 attempts per bug)
3. After all fixes, do a full re-crawl (Phase 2 + 3) to check for regressions
4. Update BUG-REPORT.md with results
5. Delete screenshot files after review to save space
