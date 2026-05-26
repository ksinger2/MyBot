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
    if (json.error) {
      console.error('[tiktok-whisper] API error:', json.error.message);
      return null;
    }
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

    // Prefer the embedded universal-data JSON (real video desc + author).
    // Falls back to meta tags when the JSON path moves or is missing.
    let title = '';
    let description = '';
    try {
      const jsonMatch = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
      if (jsonMatch) {
        const universal = JSON.parse(jsonMatch[1]);
        const scope = universal['__DEFAULT_SCOPE__'] || {};
        // TikTok renames this scope occasionally — check both known keys.
        const detail = scope['webapp.reflow.video.detail'] || scope['webapp.video-detail'];
        const item = detail?.itemInfo?.itemStruct;
        if (item?.desc) description = String(item.desc).trim();
        if (item?.author?.nickname || item?.author?.uniqueId) {
          title = `@${item.author.uniqueId || ''}${item.author.nickname ? ` (${item.author.nickname})` : ''}`.trim();
        }
      }
    } catch {}
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
      const raw = titleMatch ? titleMatch[1].trim() : '';
      // Skip TikTok's generic landing-page title.
      if (raw && raw !== 'TikTok - Make Your Day') title = raw;
    }
    if (!description) {
      const descMatch = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/);
      if (descMatch) description = descMatch[1].trim();
    }

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

  // No captions — try Whisper fallback if OpenAI key is set
  if (process.env.OPENAI_API_KEY) {
    console.log('[tiktok] No captions found, falling back to Whisper for', url);
    let canonicalUrl = url;
    if (/tiktok\.com\/t\/|vm\.tiktok\.com/.test(url)) {
      canonicalUrl = await resolveRedirect(url);
    }
    const transcript = await transcribeWithWhisper(canonicalUrl);
    if (transcript) {
      return { transcript, title: result?.title || '', description: result?.description || '' };
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
