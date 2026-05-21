'use strict';

/**
 * amazon-cart.js — Deterministic Amazon cart operations via Playwright.
 *
 * Uses the persistent browser profile at /app/data/browser-profile so
 * Amazon login state survives container restarts. All operations are
 * infrastructure-level — no Claude involvement.
 *
 * Playwright is resolved from the MCP's bundled copy (globally installed).
 * PLAYWRIGHT_BROWSERS_PATH must be set so Chromium is found.
 */

const path = require('path');

const PW_MODULE = '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright';
const BROWSER_PROFILE = '/app/data/browser-profile';
const SCREENSHOT_DIR = '/tmp';

let _lock = false;

async function _withBrowser(fn) {
  if (_lock) throw new Error('Browser is busy — another operation is in progress');
  _lock = true;
  let ctx;
  try {
    const pw = require(PW_MODULE);
    ctx = await pw.chromium.launchPersistentContext(BROWSER_PROFILE, {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      timeout: 20000,
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    // Remove navigator.webdriver flag
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return await fn(page, ctx);
  } finally {
    _lock = false;
    if (ctx) await ctx.close().catch(() => {});
  }
}

async function checkLoginStatus() {
  return _withBrowser(async (page) => {
    await page.goto('https://www.amazon.com/gp/css/homepage.html', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    const url = page.url();
    if (url.includes('/ap/signin')) {
      return { loggedIn: false, name: null, url };
    }

    const greeting = await page.$eval(
      '#nav-link-accountList-nav-line-1',
      el => el.textContent?.trim()
    ).catch(() => null);

    if (greeting && !greeting.toLowerCase().includes('sign in')) {
      const name = greeting.replace(/^hello,?\s*/i, '').trim();
      return { loggedIn: true, name: name || 'Unknown', url };
    }

    return { loggedIn: false, name: null, url };
  });
}

async function addToCart(productUrl) {
  if (!productUrl || !productUrl.includes('amazon.com')) {
    return { success: false, error: 'Not an Amazon URL' };
  }

  return _withBrowser(async (page) => {
    // First check if logged in
    await page.goto('https://www.amazon.com', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    const greeting = await page.$eval(
      '#nav-link-accountList-nav-line-1',
      el => el.textContent?.trim()
    ).catch(() => null);

    if (!greeting || greeting.toLowerCase().includes('sign in')) {
      return { success: false, error: 'Not logged in to Amazon — use `!amazon login` first' };
    }

    // Navigate to product
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Find Add to Cart button
    const addBtn = await page.$('#add-to-cart-button');
    if (!addBtn) {
      const buyBtn = await page.$('#buy-now-button');
      const title = await page.title();
      const screenshotPath = path.join(SCREENSHOT_DIR, `cart_fail_${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      return {
        success: false,
        error: buyBtn ? 'Only "Buy Now" available (no Add to Cart button)' : 'Add to Cart button not found',
        title,
        screenshotPath,
      };
    }

    await addBtn.click();

    // Wait for confirmation — Amazon shows either a side panel or redirects
    const confirmed = await page.waitForSelector(
      '#NATC_SMART_WAGON_CONF_MSG_SUCCESS, #huc-v2-order-row-confirm-text, [data-csa-c-content-id="sw_atc_confirmation"]',
      { timeout: 10000 }
    ).then(() => true).catch(() => false);

    const screenshotPath = path.join(SCREENSHOT_DIR, `cart_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    if (confirmed) {
      const cartCount = await page.$eval('#nav-cart-count', el => el.textContent?.trim()).catch(() => '?');
      return { success: true, cartCount, screenshotPath };
    }

    // Might still have worked — check cart count
    const cartCount = await page.$eval('#nav-cart-count', el => el.textContent?.trim()).catch(() => null);
    return {
      success: true,
      cartCount,
      screenshotPath,
      note: 'Added but could not confirm — check screenshot',
    };
  });
}

async function getCartContents() {
  return _withBrowser(async (page) => {
    await page.goto('https://www.amazon.com/gp/cart/view.html', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    const url = page.url();
    if (url.includes('/ap/signin')) {
      return { loggedIn: false, items: [] };
    }

    const items = await page.$$eval('.sc-list-item[data-asin]', els =>
      els.map(el => ({
        name: el.querySelector('.sc-product-title')?.textContent?.trim() || 'Unknown',
        price: el.querySelector('.sc-product-price')?.textContent?.trim() || '',
        qty: el.querySelector('.sc-quantity-textfield')?.value || '1',
      }))
    ).catch(() => []);

    const subtotal = await page.$eval('#sc-subtotal-amount-activecart', el => el.textContent?.trim()).catch(() => null);
    const screenshotPath = path.join(SCREENSHOT_DIR, `cart_view_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    return { loggedIn: true, items, subtotal, screenshotPath };
  });
}

function isBusy() { return _lock; }

module.exports = { checkLoginStatus, addToCart, getCartContents, isBusy };
