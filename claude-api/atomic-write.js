/**
 * Atomic JSON write — POSIX rename is atomic on the same filesystem, so
 * write to a sibling .tmp file first then rename. A crash during the write
 * leaves the .tmp file behind but the original target is untouched.
 *
 * Same-FS guarantee: the .tmp file goes in the same directory as the target,
 * so as long as the directory itself isn't a mount boundary the rename
 * will be atomic.
 */
const fs = require('fs');
const path = require('path');

function atomicWriteJsonSync(filePath, data, { spaces = 2 } = {}) {
  const dir = path.dirname(filePath);
  // Use process pid + a random suffix so concurrent writers don't clobber
  // each other's tmp files. Each writer gets a unique tmp name.
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, spaces));
  fs.renameSync(tmp, filePath);
}

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

module.exports = { atomicWriteJsonSync, atomicWriteFileSync };
