/**
 * TikTok transcript extractor.
 * Primary: fetches TikTok's embedded subtitleInfos VTT captions (free, no API key).
 * Fallback: downloads audio via yt-dlp and transcribes via OpenAI Whisper (~$0.006/min).
 */

const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** Resolve a short t.tiktok / vm.tiktok URL to the canonical @user/video/ID form. Follows up to 5 redirects. */
async function resolveRedirect(url) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    const next = await new Promise((resolve) => {
      const parsedUrl = new URL(current);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + (parsedUrl.search || ''),
        method: 'GET',
        headers: { 'User-Agent': MOBILE_UA },
      };
      const req = https.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Resolve relative redirects against current URL
          const location = res.headers.location;
          const resolved = location.startsWith('http') ? location : new URL(location, current).href;
          res.resume();
          resolve(resolved);
        } else {
          res.resume();
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
      req.end();
    });
    if (!next) break;
    current = next;
  }
  return current;
}

/** Fetch a URL and return the response body as a string. Follows up to 5 redirects. */
function fetchText(url, extraHeaders = {}) {
  function fetchOnce(currentUrl, hopsLeft) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(currentUrl);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': MOBILE_UA, ...extraHeaders },
      };
      https.get(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hopsLeft > 0) {
          const location = res.headers.location;
          const next = location.startsWith('http') ? location : new URL(location, currentUrl).href;
          res.resume();
          fetchOnce(next, hopsLeft - 1).then(resolve, reject);
        } else {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => resolve(data));
        }
      }).on('error', reject);
    });
  }
  return fetchOnce(url, 5);
}

/** Parse VTT/WebVTT content into plain text (strips timestamps). */
function parseVtt(vtt) {
  return vtt
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('WEBVTT') && !/^\d{2}:\d{2}/.test(line.trim()))
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Download a URL to a Buffer. */
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    function follow(currentUrl, hops) {
      const parsed = new URL(currentUrl);
      https.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { 'User-Agent': MOBILE_UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
          const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, currentUrl).href;
          res.resume();
          follow(next, hops - 1);
        } else {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }
      }).on('error', reject);
    }
    follow(url, 5);
  });
}

/**
 * Extract text from TikTok photo carousel images via GPT-4o-mini vision.
 * Scrapes image URLs from the page HTML, downloads up to MAX_SLIDES,
 * sends them to vision model to read text overlays.
 */
const MAX_CAROUSEL_SLIDES = 8;
async function extractCarouselText(html) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // Extract image URLs from TikTok's embedded JSON.
  // Strategy: find "urlList" arrays near "imageURL" keys and JSON.parse each URL
  // to properly decode unicode escapes (\u002F, \u003A, etc.)
  const imageUrls = [];
  const urlListRe = /"urlList"\s*:\s*\["((?:[^"\\]|\\.)*)"/g;
  let urlMatch;
  while ((urlMatch = urlListRe.exec(html)) !== null) {
    try {
      const decoded = JSON.parse('"' + urlMatch[1] + '"');
      if (/^https?:\/\//.test(decoded) && /image|photo|img|muscdn|tiktokcdn/i.test(decoded)) {
        imageUrls.push(decoded);
      }
    } catch {}
  }
  // Deduplicate (TikTok embeds each image URL in multiple contexts)
  const uniqueUrls = [...new Set(imageUrls)];
  if (uniqueUrls.length === 0) return null;

  // Download slides (cap to avoid excessive API cost)
  const toFetch = uniqueUrls.slice(0, MAX_CAROUSEL_SLIDES);
  console.log(`[tiktok-carousel] Downloading ${toFetch.length}/${uniqueUrls.length} slide(s) for OCR`);

  const imageContents = [];
  for (const imgUrl of toFetch) {
    try {
      const buf = await fetchBuffer(imgUrl);
      if (buf.length > 0) {
        imageContents.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } });
      }
    } catch (err) {
      console.warn(`[tiktok-carousel] Failed to download slide: ${err.message}`);
    }
  }
  if (imageContents.length === 0) return null;

  // Send to GPT-4o-mini vision for text extraction
  try {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Read ALL text visible on these TikTok carousel slides. Output the text from each slide separated by "---". Only output the text you see, nothing else.' },
          ...imageContents,
        ],
      }],
    });

    const resp = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const json = JSON.parse(resp);
    if (json.error) {
      console.warn(`[tiktok-carousel] OpenAI API error: ${json.error.message || JSON.stringify(json.error)}`);
      return null;
    }
    const text = json.choices?.[0]?.message?.content;
    if (text) {
      console.log(`[tiktok-carousel] OCR extracted ${text.length} chars from ${imageContents.length} slide(s)`);
      return text;
    }
  } catch (err) {
    console.error('[tiktok-carousel] Vision API error:', err.message);
  }
  return null;
}

/**
 * Download TikTok audio and transcribe via OpenAI Whisper.
 * Requires OPENAI_API_KEY with active billing.
 * @param {string} url - Canonical TikTok URL
 * @returns {string|null} transcript text
 */
async function transcribeWithWhisper(url) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const tmpFile = path.join(os.tmpdir(), `tiktok_${Date.now()}.mp3`);
  try {
    // Download audio with yt-dlp
    await new Promise((resolve, reject) => {
      execFile('yt-dlp', ['-x', '--audio-format', 'mp3', '-o', tmpFile, url], { timeout: 60000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    if (!fs.existsSync(tmpFile)) return null;
    const fileData = fs.readFileSync(tmpFile);
    const boundary = '----WhisperBound' + Math.random().toString(36).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        let d = '';
        res.on('data', (c) => d += c);
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const json = JSON.parse(response);
    return json.text || null;
  } catch (err) {
    console.error('[tiktok-whisper] Error:', err.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Extract transcript from a TikTok URL.
 * @param {string} url - Any TikTok URL (short or canonical)
 * @returns {{ transcript: string, title: string, description: string } | null}
 */
async function getTikTokTranscript(url) {
  try {
    // Resolve short URLs (tiktok.com/t/..., vm.tiktok.com/...)
    let canonicalUrl = url;
    if (/tiktok\.com\/t\/|vm\.tiktok\.com/.test(url)) {
      canonicalUrl = await resolveRedirect(url);
    }

    // Fetch the page with a mobile UA to get subtitle data
    const html = await fetchText(canonicalUrl);

    // Extract title and description from meta tags
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
    const descMatch = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const description = descMatch ? descMatch[1].trim() : '';

    // Extract subtitleInfos URL — TikTok embeds it as JSON-escaped Unicode in the page
    const idx = html.indexOf('subtitleInfos');
    if (idx === -1) {
      return { transcript: null, title, description };
    }

    const chunk = html.substring(idx, idx + 3000);
    const urlMatch = chunk.match(/"Url":"((?:[^"\\]|\\.)*)"/);
    if (!urlMatch) {
      return { transcript: null, title, description };
    }

    // Decode JSON unicode escapes (e.g. \u002F → /)
    const subtitleUrl = JSON.parse('"' + urlMatch[1] + '"');

    // Fetch the VTT subtitle file
    const vtt = await fetchText(subtitleUrl);
    if (!vtt || !vtt.includes('WEBVTT')) {
      return { transcript: null, title, description };
    }

    const transcript = parseVtt(vtt);
    return { transcript, title, description };
  } catch (err) {
    console.error('[tiktok-transcript] Error:', err.message);
    return null;
  }
}

/**
 * Full transcript extraction with Whisper fallback.
 * Tries captions first (free), falls back to Whisper if none found.
 */
async function getTikTokTranscriptWithFallback(url) {
  const result = await getTikTokTranscript(url);
  if (result && result.transcript) return result;

  // No captions — try Whisper fallback if OpenAI key is set.
  // Skip for photo/carousel posts (no audio to transcribe).
  if (process.env.OPENAI_API_KEY) {
    let canonicalUrl = url;
    if (/tiktok\.com\/t\/|vm\.tiktok\.com/.test(url)) {
      canonicalUrl = await resolveRedirect(url);
    }
    if (/\/photo\//.test(canonicalUrl)) {
      console.log('[tiktok] Photo/carousel post — extracting text from slides for', url);
      // Re-fetch page HTML (getTikTokTranscript already fetched it but didn't return it)
      const html = await fetchText(canonicalUrl);
      const carouselText = await extractCarouselText(html);
      if (carouselText) {
        return { transcript: carouselText, title: result?.title || '', description: result?.description || '' };
      }
      console.log('[tiktok] Carousel OCR returned no text, falling back to metadata only');
    } else {
      console.log('[tiktok] No captions found, falling back to Whisper for', url);
      const transcript = await transcribeWithWhisper(canonicalUrl);
      if (transcript) {
        return { transcript, title: result?.title || '', description: result?.description || '' };
      }
    }
  }

  return result; // return metadata even if no transcript
}

/** Returns true if the string looks like a TikTok URL. */
function isTikTokUrl(str) {
  return /(?:tiktok\.com|vm\.tiktok\.com)/i.test(str);
}

/** Extract all TikTok URLs from a string. */
function extractTikTokUrls(text) {
  const matches = text.match(/https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s<>"]+/gi);
  return matches || [];
}

module.exports = { getTikTokTranscript, getTikTokTranscriptWithFallback, isTikTokUrl, extractTikTokUrls };
