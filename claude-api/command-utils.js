const SLASH_COMMANDS = new Set(['/reinit']);

function isCommandLike(text) {
  const trimmed = (text || '').trim();
  if (/^![a-z0-9_-]+\b/i.test(trimmed)) return true;
  const slashMatch = trimmed.match(/^(\/[a-z0-9_-]+)\b/i);
  if (slashMatch && SLASH_COMMANDS.has(slashMatch[1].toLowerCase())) return true;
  return false;
}

module.exports = { isCommandLike, SLASH_COMMANDS };
