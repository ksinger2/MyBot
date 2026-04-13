# Scraper Service — Development Guidelines

## Critical: Browser Process Cleanup

This service launches headless Chromium via Playwright. Leaked browser processes become **zombies** that accumulate and exhaust system resources (memory, swap, PID space).

### Rules

1. **Every `browser = p.chromium.launch(...)` MUST have a matching `browser.close()` in a `finally` block.**
   ```python
   browser = p.chromium.launch(headless=True)
   try:
       # ... all browser work here ...
       return result
   finally:
       browser.close()
   ```

2. **Every `context = browser.new_context(...)` in async code (api.py) MUST have `await context.close()` in a `finally` block.**
   ```python
   context = await browser.new_context(...)
   try:
       # ... all page work here ...
       return result
   finally:
       await context.close()
   ```

3. **Never put `browser.close()` or `context.close()` only in the happy path.** If an exception fires between launch and close, the process leaks.

4. **Do not launch a new browser per request in the sync scrapers.** The `_fetch_with_playwright()` and `_extract_listings_with_playwright()` methods each spin up a full Chromium instance. Be aware of the cost.

5. **The shared async browser in `api.py`** (`get_browser()` / `_close_browser()`) is the correct pattern for the API layer — one browser, many contexts. Don't duplicate this with per-request browser launches in async code.

### What to check in code review

- Any new Playwright usage: does `browser.close()` / `context.close()` live in a `finally`?
- Any new subprocess or `Popen` call: is the child process waited on or killed on error?
- Applies to all process-spawning patterns, not just Playwright (e.g., ffmpeg, selenium, puppeteer).

## Architecture

- **api.py** — FastAPI/uvicorn HTTP wrapper. Shared async Playwright browser with idle timeout.
- **ticket_scraper/sites/*.py** — Per-site scraper classes using sync Playwright. Each has `_fetch_with_playwright()` and optionally `_extract_listings_with_playwright()`.
- **ticket_scraper/base.py** — Base scraper class, `ScraperResult`, `ListingInfo` models.
- **ticket_scraper/utils.py** — Shared helpers (headers, price parsing, JSON-LD extraction).
