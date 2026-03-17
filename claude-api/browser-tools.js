// Browser Tools - Puppeteer-based web automation for the agent
// Enables browsing, scraping, form filling, and interaction with any website

const fs = require('fs');
const path = require('path');

let puppeteer = null;
let browser = null;
let pages = [];  // Track multiple tabs
let currentPageIndex = 0;

// Session storage directory
const SESSION_DIR = process.env.BROWSER_SESSION_DIR || path.join(process.env.HOME || '/root', '.claude', 'browser-sessions');

// Lazy-load puppeteer (only when browser tools are actually used)
function loadPuppeteer() {
  if (!puppeteer) {
    try {
      puppeteer = require('puppeteer');
    } catch (err) {
      throw new Error('Puppeteer not installed. Browser tools require: npm install puppeteer');
    }
  }
  return puppeteer;
}

/**
 * Ensure session directory exists
 */
function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

/**
 * Get or create browser instance
 */
async function getBrowser() {
  const pptr = loadPuppeteer();
  if (!browser || !browser.isConnected()) {
    browser = await pptr.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    pages = [];
    currentPageIndex = 0;
  }
  return browser;
}

/**
 * Get or create page instance
 */
async function getPage() {
  const b = await getBrowser();
  if (pages.length === 0 || pages.every(p => p.isClosed())) {
    const page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    pages = [page];
    currentPageIndex = 0;
    return page;
  }

  // Clean up closed pages
  pages = pages.filter(p => !p.isClosed());
  if (pages.length === 0) {
    return getPage();  // Recurse to create new page
  }

  // Ensure valid index
  if (currentPageIndex >= pages.length) {
    currentPageIndex = pages.length - 1;
  }

  return pages[currentPageIndex];
}

/**
 * Navigate to a URL
 */
async function navigateTo(url) {
  const p = await getPage();
  await p.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  return {
    url: p.url(),
    title: await p.title(),
  };
}

/**
 * Get page content as text (strips HTML)
 */
async function getPageText() {
  const p = await getPage();
  const text = await p.evaluate(() => {
    // Remove scripts, styles, and hidden elements
    const scripts = document.querySelectorAll('script, style, noscript, iframe');
    scripts.forEach(s => s.remove());
    return document.body.innerText;
  });
  // Truncate if too long
  if (text.length > 50000) {
    return text.substring(0, 25000) + '\n\n...[truncated]...\n\n' + text.substring(text.length - 10000);
  }
  return text;
}

/**
 * Get page HTML
 */
async function getPageHtml() {
  const p = await getPage();
  const html = await p.content();
  if (html.length > 100000) {
    return html.substring(0, 50000) + '\n\n...[truncated]...';
  }
  return html;
}

/**
 * Extract structured data from page using a selector
 */
async function extractData(selector, attributes = ['innerText']) {
  const p = await getPage();
  const data = await p.evaluate((sel, attrs) => {
    const elements = document.querySelectorAll(sel);
    return Array.from(elements).slice(0, 100).map(el => {
      const item = {};
      attrs.forEach(attr => {
        if (attr === 'innerText') item.text = el.innerText;
        else if (attr === 'innerHTML') item.html = el.innerHTML;
        else if (attr === 'href') item.href = el.href;
        else item[attr] = el.getAttribute(attr);
      });
      return item;
    });
  }, selector, attributes);
  return data;
}

/**
 * Click an element
 */
async function clickElement(selector) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 5000 });
  await p.click(selector);
  await p.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
  return { clicked: selector, newUrl: p.url() };
}

/**
 * Double-click an element
 */
async function doubleClickElement(selector) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 5000 });
  await p.click(selector, { clickCount: 2 });
  return { doubleClicked: selector };
}

/**
 * Right-click an element (context menu)
 */
async function rightClickElement(selector) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 5000 });
  await p.click(selector, { button: 'right' });
  return { rightClicked: selector };
}

/**
 * Hover over an element
 */
async function hoverElement(selector) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 5000 });
  await p.hover(selector);
  return { hovered: selector };
}

/**
 * Type into an input field
 */
async function typeText(selector, text) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 5000 });
  await p.click(selector);
  await p.type(selector, text);
  return { typed: text.substring(0, 50), into: selector };
}

/**
 * Clear an input field and type new text
 */
async function clearAndType(selector, text) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 5000 });
  await p.click(selector, { clickCount: 3 });  // Select all
  await p.type(selector, text);
  return { typed: text.substring(0, 50), into: selector };
}

/**
 * Press a keyboard key
 */
async function pressKey(key) {
  const p = await getPage();
  await p.keyboard.press(key);
  return { pressed: key };
}

/**
 * Select an option from a dropdown
 */
async function selectDropdown(selector, value) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 5000 });
  await p.select(selector, value);
  return { selected: value, from: selector };
}

/**
 * Upload a file to a file input
 */
async function uploadFile(selector, filePath) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 5000 });
  const input = await p.$(selector);
  await input.uploadFile(filePath);
  return { uploaded: filePath, to: selector };
}

/**
 * Fill multiple form fields at once
 */
async function fillForm(fields) {
  const p = await getPage();
  const results = [];

  for (const [selector, value] of Object.entries(fields)) {
    try {
      await p.waitForSelector(selector, { timeout: 3000 });

      // Detect input type
      const inputType = await p.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return 'unknown';
        if (el.tagName === 'SELECT') return 'select';
        if (el.tagName === 'TEXTAREA') return 'textarea';
        if (el.type === 'checkbox' || el.type === 'radio') return el.type;
        return 'text';
      }, selector);

      if (inputType === 'select') {
        await p.select(selector, String(value));
      } else if (inputType === 'checkbox' || inputType === 'radio') {
        const isChecked = await p.evaluate((sel) => document.querySelector(sel).checked, selector);
        if ((value && !isChecked) || (!value && isChecked)) {
          await p.click(selector);
        }
      } else {
        await p.click(selector, { clickCount: 3 });  // Select all existing text
        await p.type(selector, String(value));
      }

      results.push({ selector, success: true });
    } catch (err) {
      results.push({ selector, success: false, error: err.message });
    }
  }

  return { filled: results };
}

/**
 * Wait for text to appear on the page
 */
async function waitForText(text, timeout = 10000) {
  const p = await getPage();
  await p.waitForFunction(
    (searchText) => document.body.innerText.includes(searchText),
    { timeout },
    text
  );
  return { found: text };
}

/**
 * Wait for navigation to complete
 */
async function waitForNavigation(timeout = 30000) {
  const p = await getPage();
  await p.waitForNavigation({ waitUntil: 'networkidle2', timeout });
  return { url: p.url(), title: await p.title() };
}

/**
 * Wait for an element
 */
async function waitForElement(selector, timeout = 5000) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout });
  return { found: selector };
}

/**
 * Get text from a specific element
 */
async function getElementText(selector) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 5000 });
  const text = await p.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText : null;
  }, selector);
  return { selector, text };
}

/**
 * Drag and drop from one element to another
 */
async function dragAndDrop(fromSelector, toSelector) {
  const p = await getPage();
  await p.waitForSelector(fromSelector, { timeout: 5000 });
  await p.waitForSelector(toSelector, { timeout: 5000 });

  const from = await p.$(fromSelector);
  const to = await p.$(toSelector);

  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();

  await p.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await p.mouse.down();
  await p.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
  await p.mouse.up();

  return { dragged: fromSelector, to: toSelector };
}

/**
 * Take a screenshot
 */
async function takeScreenshot(path) {
  const p = await getPage();
  await p.screenshot({ path, fullPage: false });
  return { saved: path };
}

/**
 * Scroll the page
 */
async function scrollPage(direction = 'down', amount = 500) {
  const p = await getPage();
  await p.evaluate((dir, amt) => {
    if (dir === 'down') window.scrollBy(0, amt);
    else if (dir === 'up') window.scrollBy(0, -amt);
    else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
    else if (dir === 'top') window.scrollTo(0, 0);
  }, direction, amount);
  return { scrolled: direction };
}

/**
 * Execute JavaScript on the page
 */
async function executeScript(script) {
  const p = await getPage();
  const result = await p.evaluate((code) => {
    try {
      return eval(code);
    } catch (e) {
      return { error: e.message };
    }
  }, script);
  return result;
}

// ==================== Tab Management ====================

/**
 * Open a new tab
 */
async function newTab(url = null) {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  pages.push(page);
  currentPageIndex = pages.length - 1;

  if (url) {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  }

  return {
    tabIndex: currentPageIndex,
    totalTabs: pages.length,
    url: page.url(),
    title: await page.title(),
  };
}

/**
 * Switch to a specific tab
 */
async function switchTab(index) {
  // Clean up closed pages first
  pages = pages.filter(p => !p.isClosed());

  if (index < 0 || index >= pages.length) {
    throw new Error(`Invalid tab index: ${index}. Available: 0-${pages.length - 1}`);
  }

  currentPageIndex = index;
  const page = pages[currentPageIndex];
  await page.bringToFront();

  return {
    switchedTo: index,
    url: page.url(),
    title: await page.title(),
    totalTabs: pages.length,
  };
}

/**
 * Close current tab
 */
async function closeTab() {
  if (pages.length === 0) {
    return { closed: false, message: 'No tabs to close' };
  }

  const page = pages[currentPageIndex];
  await page.close();
  pages.splice(currentPageIndex, 1);

  // Adjust current index
  if (currentPageIndex >= pages.length && pages.length > 0) {
    currentPageIndex = pages.length - 1;
  }

  return {
    closed: true,
    remainingTabs: pages.length,
    currentTab: currentPageIndex,
  };
}

/**
 * List all open tabs
 */
async function listTabs() {
  pages = pages.filter(p => !p.isClosed());

  const tabs = await Promise.all(pages.map(async (page, index) => ({
    index,
    url: page.url(),
    title: await page.title(),
    current: index === currentPageIndex,
  })));

  return { tabs, totalTabs: tabs.length, currentTab: currentPageIndex };
}

// ==================== Session Management ====================

/**
 * Get cookies
 */
async function getCookies() {
  const p = await getPage();
  return await p.cookies();
}

/**
 * Set cookies (for maintaining sessions)
 */
async function setCookies(cookies) {
  const p = await getPage();
  await p.setCookie(...cookies);
  return { set: cookies.length };
}

/**
 * Save session cookies to disk
 */
async function saveSession(name) {
  ensureSessionDir();
  const p = await getPage();
  const cookies = await p.cookies();
  const sessionPath = path.join(SESSION_DIR, `${name}.json`);

  const sessionData = {
    name,
    savedAt: new Date().toISOString(),
    url: p.url(),
    cookies,
  };

  fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
  return { saved: name, path: sessionPath, cookieCount: cookies.length };
}

/**
 * Restore session cookies from disk
 */
async function restoreSession(name) {
  ensureSessionDir();
  const sessionPath = path.join(SESSION_DIR, `${name}.json`);

  if (!fs.existsSync(sessionPath)) {
    throw new Error(`Session not found: ${name}. Use list_sessions to see available sessions.`);
  }

  const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
  const p = await getPage();

  if (sessionData.cookies && sessionData.cookies.length > 0) {
    await p.setCookie(...sessionData.cookies);
  }

  return {
    restored: name,
    savedAt: sessionData.savedAt,
    originalUrl: sessionData.url,
    cookieCount: sessionData.cookies?.length || 0,
  };
}

/**
 * List saved sessions
 */
function listSessions() {
  ensureSessionDir();

  const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
  const sessions = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf-8'));
      return {
        name: data.name || f.replace('.json', ''),
        savedAt: data.savedAt,
        url: data.url,
        cookieCount: data.cookies?.length || 0,
      };
    } catch {
      return { name: f.replace('.json', ''), error: 'Invalid session file' };
    }
  });

  return { sessions, count: sessions.length };
}

/**
 * Delete a saved session
 */
function deleteSession(name) {
  ensureSessionDir();
  const sessionPath = path.join(SESSION_DIR, `${name}.json`);

  if (!fs.existsSync(sessionPath)) {
    return { deleted: false, message: `Session not found: ${name}` };
  }

  fs.unlinkSync(sessionPath);
  return { deleted: true, name };
}

/**
 * Close browser
 */
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    pages = [];
    currentPageIndex = 0;
  }
  return { closed: true };
}

/**
 * Get current URL and page info
 */
async function getPageInfo() {
  const p = await getPage();
  return {
    url: p.url(),
    title: await p.title(),
    tabIndex: currentPageIndex,
    totalTabs: pages.length,
  };
}

// Tool definitions for the agent
const BROWSER_TOOLS = [
  // Navigation
  {
    name: 'browse_url',
    description: 'Navigate to a URL and load the page. Use this to visit any website.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to navigate to (e.g., https://google.com)'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'get_page_content',
    description: 'Get the text content of the current page (HTML stripped). Use this to read what\'s on the page.',
    input_schema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'Return format: "text" for readable text, "html" for raw HTML'
        }
      },
      required: []
    }
  },
  {
    name: 'extract_elements',
    description: 'Extract data from multiple elements matching a CSS selector. Use this to scrape lists, tables, posts, etc.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for elements (e.g., "article.post", "table tr", ".feed-item")'
        },
        attributes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attributes to extract: "innerText", "innerHTML", "href", or any HTML attribute'
        }
      },
      required: ['selector']
    }
  },
  {
    name: 'get_element_text',
    description: 'Get the text content of a specific element.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element'
        }
      },
      required: ['selector']
    }
  },

  // Interactions
  {
    name: 'click',
    description: 'Click an element on the page. Use this to interact with buttons, links, etc.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element to click'
        }
      },
      required: ['selector']
    }
  },
  {
    name: 'double_click',
    description: 'Double-click an element on the page.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element to double-click'
        }
      },
      required: ['selector']
    }
  },
  {
    name: 'right_click',
    description: 'Right-click an element to open context menu.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element to right-click'
        }
      },
      required: ['selector']
    }
  },
  {
    name: 'hover',
    description: 'Hover over an element (for dropdowns, tooltips, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element to hover over'
        }
      },
      required: ['selector']
    }
  },
  {
    name: 'type_input',
    description: 'Type text into an input field or textarea.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the input element'
        },
        text: {
          type: 'string',
          description: 'Text to type'
        },
        clear_first: {
          type: 'boolean',
          description: 'Clear existing text before typing (default: false)'
        }
      },
      required: ['selector', 'text']
    }
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key (Enter, Tab, Escape, Backspace, ArrowDown, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key to press (e.g., "Enter", "Tab", "Escape", "Backspace", "ArrowDown")'
        }
      },
      required: ['key']
    }
  },
  {
    name: 'select_dropdown',
    description: 'Select an option from a <select> dropdown by value.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the <select> element'
        },
        value: {
          type: 'string',
          description: 'Value of the option to select'
        }
      },
      required: ['selector', 'value']
    }
  },
  {
    name: 'fill_form',
    description: 'Fill multiple form fields at once. Handles text inputs, textareas, checkboxes, radio buttons, and selects.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          description: 'Object mapping CSS selectors to values. For checkboxes/radios, use true/false.'
        }
      },
      required: ['fields']
    }
  },
  {
    name: 'upload_file',
    description: 'Upload a file to a file input element.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the file input element'
        },
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to upload'
        }
      },
      required: ['selector', 'file_path']
    }
  },
  {
    name: 'drag_drop',
    description: 'Drag an element and drop it on another element.',
    input_schema: {
      type: 'object',
      properties: {
        from_selector: {
          type: 'string',
          description: 'CSS selector for the element to drag'
        },
        to_selector: {
          type: 'string',
          description: 'CSS selector for the drop target'
        }
      },
      required: ['from_selector', 'to_selector']
    }
  },

  // Scrolling and Navigation
  {
    name: 'scroll',
    description: 'Scroll the page to load more content or reach elements.',
    input_schema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['down', 'up', 'bottom', 'top'],
          description: 'Scroll direction'
        },
        amount: {
          type: 'integer',
          description: 'Pixels to scroll (for up/down)'
        }
      },
      required: ['direction']
    }
  },

  // Waiting
  {
    name: 'wait_for_element',
    description: 'Wait for an element to appear on the page.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to wait for'
        },
        timeout: {
          type: 'integer',
          description: 'Timeout in milliseconds (default: 5000)'
        }
      },
      required: ['selector']
    }
  },
  {
    name: 'wait_for_text',
    description: 'Wait for specific text to appear anywhere on the page.',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to wait for'
        },
        timeout: {
          type: 'integer',
          description: 'Timeout in milliseconds (default: 10000)'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'wait_for_navigation',
    description: 'Wait for page navigation to complete (after clicking a link, submitting a form, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        timeout: {
          type: 'integer',
          description: 'Timeout in milliseconds (default: 30000)'
        }
      },
      required: []
    }
  },

  // Tab Management
  {
    name: 'new_tab',
    description: 'Open a new browser tab, optionally navigating to a URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Optional URL to open in the new tab'
        }
      },
      required: []
    }
  },
  {
    name: 'switch_tab',
    description: 'Switch to a different browser tab by index.',
    input_schema: {
      type: 'object',
      properties: {
        index: {
          type: 'integer',
          description: 'Tab index (0-based)'
        }
      },
      required: ['index']
    }
  },
  {
    name: 'close_tab',
    description: 'Close the current browser tab.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'list_tabs',
    description: 'List all open browser tabs with their URLs and titles.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },

  // Session Management
  {
    name: 'save_session',
    description: 'Save current browser cookies to disk for later restoration. Use this after manually logging into a site.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for this session (e.g., "gmail", "amazon", "linkedin")'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'restore_session',
    description: 'Restore previously saved browser cookies. Use this to log in automatically to sites where you\'ve saved a session.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the session to restore'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'list_sessions',
    description: 'List all saved browser sessions.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'delete_session',
    description: 'Delete a saved browser session.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the session to delete'
        }
      },
      required: ['name']
    }
  },

  // Screenshots and Scripts
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current page.',
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename to save screenshot (e.g., "page.png")'
        }
      },
      required: ['filename']
    }
  },
  {
    name: 'run_page_script',
    description: 'Execute JavaScript on the current page. Use for complex interactions or data extraction.',
    input_schema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'JavaScript code to execute in the browser context'
        }
      },
      required: ['script']
    }
  },

  // Info and Cleanup
  {
    name: 'page_info',
    description: 'Get info about the current page (URL, title, tab info).',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'close_browser',
    description: 'Close the browser completely and clean up resources.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
];

// Execute browser tool calls
async function executeBrowserTool(toolName, input, context = {}) {
  const cwd = context.cwd || '/workspace';

  switch (toolName) {
    case 'browse_url':
      return await navigateTo(input.url);

    case 'get_page_content':
      if (input.format === 'html') {
        return await getPageHtml();
      }
      return await getPageText();

    case 'extract_elements':
      return await extractData(input.selector, input.attributes || ['innerText']);

    case 'get_element_text':
      return await getElementText(input.selector);

    case 'click':
      return await clickElement(input.selector);

    case 'double_click':
      return await doubleClickElement(input.selector);

    case 'right_click':
      return await rightClickElement(input.selector);

    case 'hover':
      return await hoverElement(input.selector);

    case 'type_input':
      if (input.clear_first) {
        return await clearAndType(input.selector, input.text);
      }
      return await typeText(input.selector, input.text);

    case 'press_key':
      return await pressKey(input.key);

    case 'select_dropdown':
      return await selectDropdown(input.selector, input.value);

    case 'fill_form':
      return await fillForm(input.fields);

    case 'upload_file':
      return await uploadFile(input.selector, input.file_path);

    case 'drag_drop':
      return await dragAndDrop(input.from_selector, input.to_selector);

    case 'scroll':
      return await scrollPage(input.direction, input.amount || 500);

    case 'wait_for_element':
      return await waitForElement(input.selector, input.timeout || 5000);

    case 'wait_for_text':
      return await waitForText(input.text, input.timeout || 10000);

    case 'wait_for_navigation':
      return await waitForNavigation(input.timeout || 30000);

    case 'new_tab':
      return await newTab(input.url);

    case 'switch_tab':
      return await switchTab(input.index);

    case 'close_tab':
      return await closeTab();

    case 'list_tabs':
      return await listTabs();

    case 'save_session':
      return await saveSession(input.name);

    case 'restore_session':
      return await restoreSession(input.name);

    case 'list_sessions':
      return listSessions();

    case 'delete_session':
      return deleteSession(input.name);

    case 'screenshot': {
      const screenshotPath = require('path');
      const fullPath = screenshotPath.isAbsolute(input.filename)
        ? input.filename
        : screenshotPath.join(cwd, input.filename);
      return await takeScreenshot(fullPath);
    }

    case 'run_page_script':
      return await executeScript(input.script);

    case 'page_info':
      return await getPageInfo();

    case 'close_browser':
      return await closeBrowser();

    default:
      throw new Error(`Unknown browser tool: ${toolName}`);
  }
}

module.exports = {
  BROWSER_TOOLS,
  executeBrowserTool,
  // Direct access for advanced use
  getBrowser,
  getPage,
  navigateTo,
  getPageText,
  getPageHtml,
  extractData,
  clickElement,
  doubleClickElement,
  rightClickElement,
  hoverElement,
  typeText,
  clearAndType,
  pressKey,
  selectDropdown,
  uploadFile,
  fillForm,
  waitForText,
  waitForNavigation,
  waitForElement,
  getElementText,
  dragAndDrop,
  scrollPage,
  takeScreenshot,
  executeScript,
  newTab,
  switchTab,
  closeTab,
  listTabs,
  saveSession,
  restoreSession,
  listSessions,
  deleteSession,
  closeBrowser,
  getCookies,
  setCookies,
};
