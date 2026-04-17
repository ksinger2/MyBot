/**
 * voice-tts.js — Text-to-Speech via ElevenLabs API.
 *
 * Converts Claude's text response into an MP3 audio buffer that can be
 * sent as a Signal attachment, giving the bot a voice.
 */
const https = require('https');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
// Default voice — Rachel (warm, conversational female). Change to match Bianca's personality.
// Browse voices at https://api.elevenlabs.io/v1/voices
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const MAX_TEXT_CHARS = 5000; // ElevenLabs limit per request

/**
 * Synthesize speech from text via ElevenLabs.
 * @param {string} text - Text to speak (max 5000 chars, truncated if longer)
 * @param {string} [voiceId] - ElevenLabs voice ID override
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
async function synthesizeSpeech(text, voiceId) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY not configured');
  }
  if (!text || !text.trim()) {
    throw new Error('No text to synthesize');
  }

  // Clean text for speech — strip markdown, tags, file paths
  let cleanText = text
    .replace(/\[(?:LEARNED|IMAGINE|WEATHER|CALENDAR|PRODUCT|CONCERT_PRICES|FLIGHT_SEARCH|REMIND|EVENT|EIGHTSLEEP|REBUILD|NOTE|RESOLVE_NOTE|UPDATE_NOTES|FLIGHT|EVENT_JOIN)[:\s][^\]]*\]/gi, '')
    .replace(/```[\s\S]*?```/g, '') // code blocks
    .replace(/`[^`]+`/g, '')        // inline code
    .replace(/\*\*(.+?)\*\*/g, '$1') // bold
    .replace(/\*(.+?)\*/g, '$1')     // italic
    .replace(/^#+\s+/gm, '')         // headers
    .replace(/^[-*]\s+/gm, '')       // list markers
    .replace(/!\[.*?\]\(.*?\)/g, '') // images
    .replace(/\[(.+?)\]\(.*?\)/g, '$1') // links → just text
    .replace(/\/[\w/.-]+\.\w{2,4}/g, '') // file paths
    .replace(/\n{3,}/g, '\n\n')      // excess newlines
    .trim();

  if (!cleanText) throw new Error('Text was empty after cleaning');
  if (cleanText.length > MAX_TEXT_CHARS) {
    cleanText = cleanText.substring(0, MAX_TEXT_CHARS - 3) + '...';
  }

  const vid = voiceId || DEFAULT_VOICE_ID;
  const body = JSON.stringify({
    text: cleanText,
    model_id: 'eleven_turbo_v2_5',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${vid}`,
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const errBody = Buffer.concat(chunks).toString();
          reject(new Error(`ElevenLabs API error ${res.statusCode}: ${errBody.substring(0, 200)}`));
        });
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Check if TTS is available (API key configured).
 */
function isAvailable() {
  return !!ELEVENLABS_API_KEY;
}

module.exports = { synthesizeSpeech, isAvailable };
