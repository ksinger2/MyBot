/**
 * Instagram Reels transcript extractor.
 * Unlike TikTok, Instagram has NO embedded caption data in the page HTML —
 * captions are burned into the video. Whisper is the only reliable approach.
 *
 * Also extracts user-written caption text (the description) as a bonus.
 */

const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Returns true if the string looks like an Instagram Reel URL. */
function isInstagramReelUrl(str) {
  return /instagram\.com\/(reel|reels|p)\//i.test(str);
}

/** Extract all Instagram Reel URLs from a string. */
function extractInstagramReelUrls(text) {
  const matches = text.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\/[^\s<>"]+/gi);
  return matches || [];
}

/** Fetch a URL and return the body as a string. */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/**
 * Extract user-written caption and basic metadata from Instagram page HTML.
 * This is NOT a transcript — just the description the creator wrote.
 */
function extractCaptionFromHtml(html) {
  // Try og:description meta tag (most reliable, no auth needed)
  const ogDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/);
  if (ogDesc) return ogDesc[1].trim();
  const ogDesc2 = html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/);
  if (ogDesc2) return ogDesc2[1].trim();
  return null;
}

/**
 * Download audio from an Instagram Reel and transcribe with OpenAI Whisper.
 */
async function transcribeWithWhisper(url) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const tmpFile = path.join(os.tmpdir(), `ig_${Date.now()}.mp3`);
  try {
    await new Promise((resolve, reject) => {
      execFile('yt-dlp', [
        '-x', '--audio-format', 'mp3',
        '--no-playlist',
        '-o', tmpFile,
        url,
      ], { timeout: 90000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    if (!fs.existsSync(tmpFile)) return null;
    const fileData = fs.readFileSync(tmpFile);
    const boundary = '----IGWhisper' + Math.random().toString(36).slice(2);
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
      console.error('[instagram-whisper] API error:', json.error.message);
      return null;
    }
    return json.text || null;
  } catch (err) {
    console.error('[instagram-transcript] Whisper error:', err.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Get transcript + metadata for an Instagram Reel.
 * @param {string} url
 * @returns {{ transcript: string|null, description: string|null } | null}
 */
async function getInstagramTranscript(url) {
  try {
    // Try to get the user-written caption from the page (free, no auth)
    let description = null;
    try {
      const html = await fetchText(url);
      description = extractCaptionFromHtml(html);
    } catch {}

    // Transcribe audio with Whisper
    let transcript = null;
    if (process.env.OPENAI_API_KEY) {
      console.log('[instagram] Fetching Whisper transcript for', url);
      transcript = await transcribeWithWhisper(url);
    }

    return { transcript, description };
  } catch (err) {
    console.error('[instagram-transcript] Error:', err.message);
    return null;
  }
}

module.exports = { getInstagramTranscript, isInstagramReelUrl, extractInstagramReelUrls };
