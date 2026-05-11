function isCommandLike(text) {
  return /^[/!][a-z0-9_-]+\b/i.test((text || '').trim());
}

module.exports = { isCommandLike };
