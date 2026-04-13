"""
FastAPI HTTP wrapper for the ticket scraper library.

Endpoints:
  POST /scrape   — scrape prices from a known event URL
  POST /search   — search for an event by artist/venue/date, then scrape prices
  GET  /health   — health check
"""

import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from ticket_scraper.utils import detect_site, get_scraper, parse_price
from ticket_scraper.base import ScraperResult

# Lazy Playwright imports — only needed for search
try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
log = logging.getLogger("scraper-api")

# ── Browser lifecycle (shared async Playwright instance) ──────────────────────

_playwright = None
_browser = None
_idle_timer = None
IDLE_TIMEOUT = 300  # 5 minutes


async def get_browser():
    global _playwright, _browser, _idle_timer
    if _idle_timer:
        _idle_timer.cancel()
        _idle_timer = None

    if _browser and _browser.is_connected():
        _schedule_idle_close()
        return _browser

    log.info("Launching Chromium...")
    _playwright = await async_playwright().start()
    _browser = await _playwright.chromium.launch(
        headless=True,
        args=[
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
        ],
    )
    _schedule_idle_close()
    return _browser


def _schedule_idle_close():
    global _idle_timer
    loop = asyncio.get_event_loop()
    _idle_timer = loop.call_later(IDLE_TIMEOUT, lambda: asyncio.ensure_future(_close_browser()))


async def _close_browser():
    global _playwright, _browser, _idle_timer
    if _idle_timer:
        _idle_timer.cancel()
        _idle_timer = None
    if _browser:
        log.info("Idle timeout — closing browser")
        try:
            await _browser.close()
        except Exception:
            pass
        _browser = None
    if _playwright:
        try:
            await _playwright.stop()
        except Exception:
            pass
        _playwright = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await _close_browser()


app = FastAPI(title="ConcertScraper API", lifespan=lifespan)

# ── Request / Response models ─────────────────────────────────────────────────


class ScrapeRequest(BaseModel):
    url: str


class SearchRequest(BaseModel):
    site: str
    artist: str
    venue: Optional[str] = ""
    date: str  # YYYY-MM-DD
    city: Optional[str] = ""


class ListingResponse(BaseModel):
    price: float
    section: str = ""
    row: str = ""
    labels: list[str] = []
    quantity: Optional[int] = None
    listing_id: Optional[str] = None
    url: Optional[str] = None


class PriceResponse(BaseModel):
    site: str
    min: Optional[float] = None
    max: Optional[float] = None
    includes_fees: bool = False
    url: Optional[str] = None
    section_breakdown: Optional[dict] = None  # { "Section Name": { "min": float, "max": float, "count": int } }
    listings: Optional[list[ListingResponse]] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun",
               "jul", "aug", "sep", "oct", "nov", "dec"]

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def _score_event_card(href: str, text: str, target_date: str,
                      venue_name: str = "", venue_city: str = "",
                      site: str = "stubhub") -> int:
    """Score an event card for match quality. Ported from Node.js scraper.js."""
    score = 0
    href_lower = href.lower()
    text_lower = text.lower()

    target_dt = datetime.strptime(target_date, "%Y-%m-%d")
    target_day = target_date  # YYYY-MM-DD
    target_month = target_dt.month - 1  # 0-indexed for MONTH_NAMES
    target_day_num = target_dt.day

    venue_lower = venue_name.lower() if venue_name else ""
    city_lower = venue_city.lower().split(",")[0].strip() if venue_city else ""

    # Date in URL slug: -M-D-YYYY pattern (4-digit year)
    date_match = re.search(r"-(\d{1,2})-(\d{1,2})-(\d{4})(?:/|$)", href)
    if date_match:
        month, day, year = date_match.group(1), date_match.group(2), date_match.group(3)
        card_date = f"{year}-{month.zfill(2)}-{day.zfill(2)}"
        if card_date == target_day:
            score += 10
        else:
            score -= 5
    else:
        # Try 2-digit year (TickPick uses e.g. 5-14-26)
        date_match_2y = re.search(r"-(\d{1,2})-(\d{1,2})-(\d{2})(?:/|-|$)", href)
        if date_match_2y:
            month = date_match_2y.group(1)
            day = date_match_2y.group(2)
            year = "20" + date_match_2y.group(3)
            card_date = f"{year}-{month.zfill(2)}-{day.zfill(2)}"
            if card_date == target_day:
                score += 10
            else:
                score -= 5
        else:
            score += 1  # no date in URL — weak candidate

    # City in URL slug (StubHub uses city in slug)
    if city_lower and f"-{city_lower}-" in href_lower:
        score += 8

    # Venue name in card text
    if venue_lower and venue_lower in text_lower:
        score += 5
    elif venue_lower:
        score -= 3  # venue provided but doesn't match — likely wrong event

    # City name in card text
    if city_lower and city_lower in text_lower:
        score += 3
    elif city_lower:
        score -= 2  # city provided but doesn't match

    # Date in card text (e.g. "Jun 7", "Mar 14")
    month_str = MONTH_NAMES[target_month]
    if f"{month_str} {target_day_num}" in text_lower:
        score += 7

    return score


def _find_best_match(event_cards: list[dict], target_date: str,
                     venue_name: str = "", venue_city: str = "",
                     site: str = "stubhub") -> Optional[dict]:
    """Find the best matching event card from a list."""
    if not event_cards:
        return None

    best = None
    best_score = -1

    for card in event_cards:
        score = _score_event_card(
            card["href"], card["text"], target_date,
            venue_name, venue_city, site
        )
        log.debug(f"  card score={score}: {card['href'][:100]}")
        if score > best_score:
            best_score = score
            best = card

    if best_score <= 0:
        log.info(f"{site}: no card with positive score")
        return None

    log.info(f"{site}: best score={best_score}, href={best['href'][:100]}")
    return best


def _build_response_from_listings(
    listing_dicts: list[dict], site: str, url: str, fees: bool
) -> Optional[PriceResponse]:
    """Build a PriceResponse with listings, section_breakdown, and min/max from raw listing dicts.

    Each dict should have: price, section, row, labels, listing_id, quantity (all optional except price).
    """
    valid = [l for l in listing_dicts if l.get("price") and l["price"] >= 10]
    if not valid:
        return None

    prices = [l["price"] for l in valid]
    min_price = min(prices)
    max_price = max(prices)

    # Build section breakdown
    section_map: dict = {}
    for l in valid:
        sec = l.get("section") or ""
        if not sec or len(sec) > 40:
            continue
        if sec not in section_map:
            section_map[sec] = {"min": l["price"], "max": l["price"], "count": 0}
        section_map[sec]["min"] = min(section_map[sec]["min"], l["price"])
        section_map[sec]["max"] = max(section_map[sec]["max"], l["price"])
        section_map[sec]["count"] += 1

    section_breakdown = section_map if len(section_map) > 1 else None

    listing_responses = []
    for l in valid:
        lid = l.get("listing_id") or l.get("listingId")
        # Construct per-listing URL: StubHub checkout deep-link, others event page
        listing_url = l.get("url")
        if not listing_url:
            listing_url = url  # event page
        listing_responses.append(ListingResponse(
            price=l["price"],
            section=l.get("section", ""),
            row=l.get("row", ""),
            labels=l.get("labels", []),
            quantity=l.get("quantity"),
            listing_id=lid,
            url=listing_url,
        ))

    return PriceResponse(
        site=site,
        min=min_price,
        max=max_price,
        includes_fees=fees,
        url=url,
        section_breakdown=section_breakdown,
        listings=listing_responses,
    )


def _listings_to_dicts(listings) -> list[dict]:
    """Convert ListingInfo objects to dicts (works with both ListingInfo and raw dicts)."""
    result = []
    for l in listings:
        if hasattr(l, 'to_dict'):
            result.append(l.to_dict())
        elif isinstance(l, dict):
            result.append(l)
    return result


def _scraper_result_to_response(result: ScraperResult, site: str) -> PriceResponse:
    """Convert a ScraperResult to our API response format."""
    min_price = None
    max_price = None

    if result.lowest_all_in is not None:
        min_price = result.lowest_all_in

    if result.price_range:
        if result.price_range.get("low"):
            min_price = min_price or parse_price(result.price_range["low"])
        if result.price_range.get("high"):
            max_price = parse_price(result.price_range["high"])

    # If we have listings, compute max from them
    if min_price and not max_price:
        max_price = min_price

    return PriceResponse(
        site=site,
        min=min_price,
        max=max_price,
        includes_fees=result.fees_included,
        url=result.url,
    )


# ── Search functions (one per site) ──────────────────────────────────────────

async def _search_stubhub(artist: str, venue: str, date: str, city: str) -> Optional[PriceResponse]:
    browser = await get_browser()
    context = await browser.new_context(user_agent=USER_AGENT, viewport={"width": 1280, "height": 720})
    page = await context.new_page()

    try:
        city_slug = city.split(",")[0].strip() if city else ""
        query = f"{artist} {city_slug}" if city_slug else artist
        search_url = f"https://www.stubhub.com/search?q={_urlencode(query)}"
        log.info(f"StubHub search: {search_url}")

        await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_selector('a[href*="-tickets-"]', timeout=15000)
        except Exception:
            log.info("StubHub: no event links found")
            return None

        event_cards = await page.evaluate("""() => {
            const links = Array.from(document.querySelectorAll('a[href*="-tickets-"]'));
            return links.map(a => ({ href: a.href, text: a.innerText || '' }));
        }""")

        log.info(f"StubHub: found {len(event_cards)} event links")
        match = _find_best_match(event_cards, date, venue, city, "stubhub")
        if not match:
            return None

        event_url = match["href"]

        # Add price-sort params
        parsed = urlparse(event_url)
        params = parse_qs(parsed.query)
        params["sortBy"] = ["NEWPRICE"]
        params["sortDirection"] = ["0"]
        params["quantity"] = ["2"]
        event_url = urlunparse(parsed._replace(query=urlencode(params, doseq=True)))

        # Set up API response interception to capture all listings
        captured_sh_listings = []

        async def handle_sh_response(response):
            try:
                url = response.url
                if not any(p in url for p in ["/listing", "/catalog", "/search/inventory", "/event-listings"]):
                    return
                ct = response.headers.get("content-type", "")
                if "json" not in ct:
                    return
                body = await response.json()
                items = (body if isinstance(body, list) else
                         body.get("items") or body.get("listings") or
                         body.get("results") or body.get("data", []))
                if not isinstance(items, list):
                    return
                for item in items:
                    price = None
                    for pf in ["totalPrice", "priceWithFees", "allInPrice", "displayPrice", "price"]:
                        v = item.get(pf)
                        if isinstance(v, dict):
                            price = v.get("amount") or v.get("value")
                        elif isinstance(v, (int, float)) and v > 0:
                            price = float(v)
                        elif isinstance(v, str):
                            price = parse_price(v)
                        if price:
                            break
                    if not price or price < 10:
                        continue
                    section = item.get("section") or item.get("sectionName") or ""
                    row = item.get("row") or item.get("rowName") or ""
                    captured_sh_listings.append({
                        "price": price,
                        "section": str(section),
                        "row": str(row),
                        "labels": [],
                        "listing_id": str(item.get("id") or item.get("listingId") or ""),
                    })
            except Exception:
                pass

        page.on("response", handle_sh_response)

        # Check for geo-redirect
        await page.goto(event_url, wait_until="domcontentloaded", timeout=30000)
        event_id_match = re.search(r"/event/(\d+)", event_url)
        if event_id_match and event_id_match.group(1) not in page.url:
            log.info(f"StubHub: geo-redirected ({page.url}), skipping")
            return None

        await page.wait_for_timeout(8000)

        # Scroll to trigger more API calls
        for _ in range(5):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(2000)

        # Deduplicate API-captured listings
        api_sh_listings = []
        if captured_sh_listings:
            seen = set()
            for l in captured_sh_listings:
                lid = l.get("listing_id")
                key = lid if lid else f"{l['price']}-{l.get('section','')}-{l.get('row','')}"
                if key not in seen:
                    seen.add(key)
                    api_sh_listings.append(l)
            log.info(f"StubHub: {len(api_sh_listings)} listings from API intercept")

        # Also try DOM extraction
        raw_listings = await page.evaluate("""() => {
            const elements = Array.from(document.querySelectorAll('[data-listing-id]'));
            return elements.map(el => {
                const text = el.textContent || '';
                const lowerText = text.toLowerCase();
                let price = null;
                let feesIncluded = false;

                const feeMatch = text.match(/\\$(\\d{1,5}(?:\\.\\d{2})?)\\s*incl\\.\\s*fees/i);
                if (feeMatch) { price = parseFloat(feeMatch[1]); feesIncluded = true; }
                if (!price) {
                    const priceMatch = text.match(/\\$(\\d{1,5}(?:\\.\\d{2})?)\\s*(?:each|per\\s+ticket)/i);
                    if (priceMatch) price = parseFloat(priceMatch[1]);
                }
                if (!price) return null;

                const sectionEl = el.querySelector('[class*="section"], [class*="Section"], [data-section]');
                let section = '';
                if (sectionEl) {
                    section = sectionEl.textContent.trim();
                } else {
                    const secMatch = text.match(/(?:Section|Sec\\.?|Floor|GA\\b|General Admission|Pit|Field|Lawn|Balcony|Orchestra|Mezzanine|Loge|Club|Suite|Box)\\s*[A-Za-z0-9\\-]*/i);
                    if (secMatch) section = secMatch[0].trim();
                }

                const rowMatch = text.match(/Row\\s+([A-Za-z0-9]+)/i);
                const row = rowMatch ? rowMatch[1] : '';
                const labels = [];
                if (lowerText.includes('best price')) labels.push('Best price');

                return {
                    price: price, section: section, row: row,
                    listing_id: el.getAttribute('data-listing-id'),
                    labels: labels, feesIncluded: feesIncluded,
                };
            }).filter(l => l && l.price >= 10);
        }""")

        dom_listings = raw_listings if raw_listings else []
        if dom_listings:
            log.info(f"StubHub: {len(dom_listings)} listings from DOM")

        # Also try Next.js data
        html = await page.content()
        loop = asyncio.get_event_loop()
        from ticket_scraper.sites.stubhub import StubHubScraper
        sh = StubHubScraper()
        nextjs_listings = []
        try:
            nj = await loop.run_in_executor(
                None, lambda: sh._extract_nextjs_listings(html)
            )
            if nj:
                nextjs_listings = _listings_to_dicts(nj)
                log.info(f"StubHub: {len(nextjs_listings)} listings from Next.js")
        except Exception:
            pass

        # Use whichever source got more listings
        candidates = [(api_sh_listings, True), (dom_listings, any(l.get("feesIncluded") for l in dom_listings)), (nextjs_listings, False)]
        best, fees = max(candidates, key=lambda x: len(x[0]))
        if best:
            resp = _build_response_from_listings(best, "stubhub", event_url, fees)
            if resp:
                return resp

        return _extract_prices_from_html(html, "stubhub", event_url)

    except Exception as e:
        log.error(f"StubHub search error: {e}")
        return None
    finally:
        await context.close()


async def _search_vividseats(artist: str, venue: str, date: str, city: str) -> Optional[PriceResponse]:
    browser = await get_browser()
    context = await browser.new_context(user_agent=USER_AGENT, viewport={"width": 1280, "height": 720})
    page = await context.new_page()

    try:
        search_url = f"https://www.vividseats.com/search?searchTerm={_urlencode(artist)}"
        log.info(f"VividSeats search: {search_url}")

        await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
        try:
            await asyncio.wait_for(
                asyncio.gather(
                    page.wait_for_selector('a[href*="-tickets-"]', timeout=15000),
                    return_exceptions=True,
                ),
                timeout=16,
            )
        except Exception:
            try:
                await page.wait_for_selector('a[href*="/production/"]', timeout=5000)
            except Exception:
                log.info("VividSeats: no event links found")
                return None

        event_cards = await page.evaluate("""() => {
            const links = Array.from(document.querySelectorAll('a[href*="-tickets-"], a[href*="/production/"]'));
            const seen = new Set();
            return links.filter(a => { if (seen.has(a.href)) return false; seen.add(a.href); return true; })
                        .map(a => ({ href: a.href, text: a.innerText || '' }));
        }""")

        log.info(f"VividSeats: found {len(event_cards)} event links")
        match = _find_best_match(event_cards, date, venue, city, "vividseats")
        if not match:
            return None

        event_url = match["href"]

        # Add price sort
        event_url += ("&" if "?" in event_url else "?") + "sort=price_asc"

        # Set up API response interception to capture all listings
        captured_listings = []

        async def handle_vs_response(response):
            try:
                url = response.url
                if not any(p in url for p in ["/listings", "/tickets", "ticketGroup", "inventory"]):
                    return
                ct = response.headers.get("content-type", "")
                if "json" not in ct:
                    return
                body = await response.json()
                items = (body if isinstance(body, list) else
                         body.get("listings") or body.get("ticketGroups") or
                         body.get("items") or body.get("results") or
                         body.get("data", []))
                if not isinstance(items, list):
                    return
                for item in items:
                    price = parse_price(item.get("price") or item.get("listPrice"))
                    if price and price >= 10:
                        captured_listings.append({
                            "price": price,
                            "section": item.get("section", ""),
                            "row": item.get("row", ""),
                            "labels": [],
                            "quantity": item.get("quantity"),
                            "listing_id": str(item.get("id", "")),
                        })
            except Exception:
                pass

        page.on("response", handle_vs_response)

        # Navigate to event page (triggers API calls)
        await page.goto(event_url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(6000)

        # Scroll to trigger pagination API calls
        for _ in range(5):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(2000)

        # Deduplicate API-captured listings
        api_listings = []
        if captured_listings:
            seen = set()
            for l in captured_listings:
                lid = l.get("listing_id")
                key = lid if lid else f"{l['price']}-{l.get('section','')}-{l.get('row','')}"
                if key not in seen:
                    seen.add(key)
                    api_listings.append(l)
            log.info(f"VividSeats: {len(api_listings)} listings from API intercept")

        # Also try embedded data extraction
        html = await page.content()
        loop = asyncio.get_event_loop()
        from ticket_scraper.sites.vividseats import VividSeatsScraper
        vs = VividSeatsScraper()
        embedded_listings = []
        try:
            _, listings = await loop.run_in_executor(
                None, lambda: vs._extract_embedded_data(html)
            )
            if not listings:
                listings = await loop.run_in_executor(
                    None, lambda: vs._extract_listings_from_html(html)
                )
            if listings:
                embedded_listings = _listings_to_dicts(listings)
                log.info(f"VividSeats: {len(embedded_listings)} listings from embedded data")
        except Exception as e:
            log.warning(f"VividSeats listing extraction failed: {e}")

        # Use whichever source got more listings
        best_listings = api_listings if len(api_listings) >= len(embedded_listings) else embedded_listings
        if best_listings:
            resp = _build_response_from_listings(best_listings, "vividseats", event_url, False)
            if resp:
                return resp

        # Fallback to JSON-LD min/max
        return _extract_prices_from_html(html, "vividseats", event_url)

    except Exception as e:
        log.error(f"VividSeats search error: {e}")
        return None
    finally:
        await context.close()


async def _search_tickpick(artist: str, venue: str, date: str, city: str) -> Optional[PriceResponse]:
    browser = await get_browser()
    context = await browser.new_context(user_agent=USER_AGENT, viewport={"width": 1280, "height": 720})
    page = await context.new_page()

    try:
        search_url = f"https://www.tickpick.com/search?q={_urlencode(artist)}"
        log.info(f"TickPick search: {search_url}")

        await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_selector('a[href*="/buy-"]', timeout=15000)
        except Exception:
            log.info("TickPick: no event links found")
            return None

        event_cards = await page.evaluate("""() => {
            const links = Array.from(document.querySelectorAll('a[href*="/buy-"]'));
            const seen = new Set();
            return links.filter(a => { if (seen.has(a.href)) return false; seen.add(a.href); return true; })
                        .map(a => ({ href: a.href, text: a.innerText || '' }));
        }""")

        log.info(f"TickPick: found {len(event_cards)} event links")
        match = _find_best_match(event_cards, date, venue, city, "tickpick")
        if not match:
            return None

        event_url = match["href"]

        # Add price sort
        event_url += ("&" if "?" in event_url else "?") + "sort=p"

        # Navigate to event page
        await page.goto(event_url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(6000)

        # Scroll to load more listings
        for _ in range(3):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(1500)

        html = await page.content()

        # Try scraper library for per-listing data
        loop = asyncio.get_event_loop()
        from ticket_scraper.sites.tickpick import TickPickScraper
        tp = TickPickScraper()
        try:
            listings = await loop.run_in_executor(
                None, lambda: tp._extract_listings_from_html(html)
            )
            if not listings:
                listings = await loop.run_in_executor(
                    None, lambda: tp._extract_listings_from_script(html)
                )
            if listings:
                resp = _build_response_from_listings(
                    _listings_to_dicts(listings), "tickpick", event_url, True  # TickPick always all-in
                )
                if resp:
                    return resp
        except Exception as e:
            log.warning(f"TickPick listing extraction failed: {e}")

        # Fallback to JSON-LD min/max
        result = _extract_prices_from_html(html, "tickpick", event_url)
        if result:
            result.includes_fees = True
        return result

    except Exception as e:
        log.error(f"TickPick search error: {e}")
        return None
    finally:
        await context.close()


async def _search_ticketmaster(artist: str, venue: str, date: str, city: str) -> Optional[PriceResponse]:
    """Ticketmaster search — we don't actually search TM via browser, just use the scraper on a URL."""
    # TM is primarily handled via API in the Node.js bot, but if we get a search request
    # we can try a basic search
    browser = await get_browser()
    context = await browser.new_context(user_agent=USER_AGENT, viewport={"width": 1280, "height": 720})
    page = await context.new_page()

    try:
        search_url = f"https://www.ticketmaster.com/search?q={_urlencode(artist)}"
        log.info(f"Ticketmaster search: {search_url}")

        await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_selector('a[href*="/event/"]', timeout=15000)
        except Exception:
            log.info("Ticketmaster: no event links found")
            return None

        event_cards = await page.evaluate("""() => {
            const links = Array.from(document.querySelectorAll('a[href*="/event/"]'));
            const seen = new Set();
            return links.filter(a => { if (seen.has(a.href)) return false; seen.add(a.href); return true; })
                        .map(a => ({ href: a.href, text: a.innerText || '' }));
        }""")

        log.info(f"Ticketmaster: found {len(event_cards)} event links")
        match = _find_best_match(event_cards, date, venue, city, "ticketmaster")
        if not match:
            return None

        event_url = match["href"]
        await page.goto(event_url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(5000)
        html = await page.content()

        # Try scraper library for per-listing data
        loop = asyncio.get_event_loop()
        from ticket_scraper.sites.ticketmaster import TicketmasterScraper
        tm = TicketmasterScraper()
        try:
            listings = await loop.run_in_executor(
                None, lambda: tm._extract_listings_from_html(html)
            )
            if listings:
                resp = _build_response_from_listings(
                    _listings_to_dicts(listings), "ticketmaster", event_url, False
                )
                if resp:
                    return resp
        except Exception as e:
            log.warning(f"Ticketmaster listing extraction failed: {e}")

        return _extract_prices_from_html(html, "ticketmaster", event_url)

    except Exception as e:
        log.error(f"Ticketmaster search error: {e}")
        return None
    finally:
        await context.close()


async def _search_seatgeek(artist: str, venue: str, date: str, city: str) -> Optional[PriceResponse]:
    browser = await get_browser()
    context = await browser.new_context(user_agent=USER_AGENT, viewport={"width": 1280, "height": 720})
    page = await context.new_page()

    try:
        search_url = f"https://seatgeek.com/search?search={_urlencode(artist)}"
        log.info(f"SeatGeek search: {search_url}")

        await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_selector('a[href*="/tickets"]', timeout=15000)
        except Exception:
            log.info("SeatGeek: no event links found")
            return None

        event_cards = await page.evaluate("""() => {
            const links = Array.from(document.querySelectorAll('a[href*="/tickets"]'));
            const seen = new Set();
            return links.filter(a => { if (seen.has(a.href)) return false; seen.add(a.href); return true; })
                        .map(a => ({ href: a.href, text: a.innerText || '' }));
        }""")

        log.info(f"SeatGeek: found {len(event_cards)} event links")
        match = _find_best_match(event_cards, date, venue, city, "seatgeek")
        if not match:
            return None

        event_url = match["href"]

        await page.goto(event_url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(6000)
        html = await page.content()

        # Try scraper library for per-listing data
        loop = asyncio.get_event_loop()
        from ticket_scraper.sites.seatgeek import SeatGeekScraper
        sg = SeatGeekScraper()
        try:
            _, listings = await loop.run_in_executor(
                None, lambda: sg._extract_embedded_data(html)
            )
            if not listings:
                listings = await loop.run_in_executor(
                    None, lambda: sg._extract_listings_from_html(html)
                )
            if listings:
                resp = _build_response_from_listings(
                    _listings_to_dicts(listings), "seatgeek", event_url, False
                )
                if resp:
                    return resp
        except Exception as e:
            log.warning(f"SeatGeek listing extraction failed: {e}")

        return _extract_prices_from_html(html, "seatgeek", event_url)

    except Exception as e:
        log.error(f"SeatGeek search error: {e}")
        return None
    finally:
        await context.close()


SEARCH_HANDLERS = {
    "stubhub": _search_stubhub,
    "vividseats": _search_vividseats,
    "tickpick": _search_tickpick,
    "seatgeek": _search_seatgeek,
    "ticketmaster": _search_ticketmaster,
}


def _extract_prices_from_html(html: str, site: str, event_url: str) -> Optional[PriceResponse]:
    """Use the Python scraper library's extraction on raw HTML (JSON-LD + BeautifulSoup)."""
    from ticket_scraper.utils import extract_json_ld, extract_event_from_json_ld

    json_ld = extract_json_ld(html)

    # Extract prices from JSON-LD offers
    min_price = None
    max_price = None
    for item in json_ld:
        offers = item.get("offers", {})
        offer_list = offers if isinstance(offers, list) else [offers]
        for o in offer_list:
            if not isinstance(o, dict):
                continue
            low = parse_price(o.get("lowPrice"))
            high = parse_price(o.get("highPrice"))
            price = parse_price(o.get("price"))
            if low:
                min_price = min(min_price, low) if min_price else low
            if high:
                max_price = max(max_price, high) if max_price else high
            if price:
                min_price = min(min_price, price) if min_price else price
                max_price = max(max_price, price) if max_price else price

    if min_price:
        fees_map = {"stubhub": True, "tickpick": True, "vividseats": False, "ticketmaster": False, "seatgeek": False}
        return PriceResponse(
            site=site,
            min=min_price,
            max=max_price or min_price,
            includes_fees=fees_map.get(site, False),
            url=event_url,
        )

    return None


def _urlencode(s: str) -> str:
    from urllib.parse import quote
    return quote(s, safe="")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/scrape", response_model=PriceResponse)
async def scrape(req: ScrapeRequest):
    """Scrape prices from a known event URL using the Python scraper library."""
    site_name = detect_site(req.url)
    if not site_name:
        raise HTTPException(400, f"Could not detect site from URL: {req.url}")

    log.info(f"Scraping {site_name}: {req.url[:100]}")

    try:
        scraper = get_scraper(site_name)
        # Run synchronous scraper in thread pool to avoid blocking
        loop = asyncio.get_event_loop()

        # Try to get full listings first
        try:
            listings = await loop.run_in_executor(
                None, lambda: scraper.get_listings(req.url)
            )
            if listings:
                resp = _build_response_from_listings(
                    _listings_to_dicts(listings), site_name, req.url,
                    scraper.all_in_pricing,
                )
                if resp:
                    log.info(f"Scrape result: ${resp.min} - ${resp.max}, {len(listings)} listings ({site_name})")
                    return resp
        except Exception as e:
            log.warning(f"Listing extraction failed for {site_name}, falling back: {e}")

        # Fallback to lowest price only
        result: ScraperResult = await loop.run_in_executor(
            None, lambda: scraper.get_lowest_price(req.url)
        )
        response = _scraper_result_to_response(result, site_name)
        if not response.url:
            response.url = req.url
        log.info(f"Scrape result: ${response.min} - ${response.max} ({site_name})")
        return response
    except Exception as e:
        log.error(f"Scrape error ({site_name}): {e}")
        raise HTTPException(500, str(e))


@app.post("/search", response_model=PriceResponse)
async def search(req: SearchRequest):
    """Search for an event by artist/venue/date, then scrape prices."""
    site = req.site.lower()
    handler = SEARCH_HANDLERS.get(site)
    if not handler:
        raise HTTPException(400, f"Unsupported site for search: {site}. Supported: {list(SEARCH_HANDLERS.keys())}")

    if not PLAYWRIGHT_AVAILABLE:
        raise HTTPException(503, "Playwright not installed — search requires browser automation")

    log.info(f"Search {site}: artist={req.artist}, venue={req.venue}, date={req.date}, city={req.city}")

    result = await handler(req.artist, req.venue or "", req.date, req.city or "")
    if not result:
        raise HTTPException(404, f"No matching event found on {site}")

    log.info(f"Search result: ${result.min} - ${result.max} ({site})")
    return result
