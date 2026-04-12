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
  if (fs.existsSync(dir)) {
    try { fs.accessSync(dir, fs.constants.W_OK); } catch {
      throw new Error(`atomic-write: directory not writable: ${dir} (check bind mounts and permissions)`);
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, spaces));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up orphaned .tmp file on any failure
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  if (fs.existsSync(dir)) {
    try { fs.accessSync(dir, fs.constants.W_OK); } catch {
      throw new Error(`atomic-write: directory not writable: ${dir} (check bind mounts and permissions)`);
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up orphaned .tmp file on any failure
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Boot-time sweep: remove orphaned .tmp files left by previous crashes.
 * Call early in startup, before any store reads.
 */
function sweepOrphanTmpFiles(dirs) {
  const TMP_RE = /^\..+\.\d+\.[a-z0-9]+\.tmp$/;
  let total = 0;
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!TMP_RE.test(name)) continue;
        try {
          fs.unlinkSync(path.join(dir, name));
          total++;
        } catch {}
      }
    } catch {}
  }
  if (total > 0) console.log(`[atomic-write] swept ${total} orphaned .tmp file(s) on startup`);
}

module.exports = { atomicWriteJsonSync, atomicWriteFileSync, sweepOrphanTmpFiles };
