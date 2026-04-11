const fs = require('fs');
const path = require('path');

const BACKUP_DIR = '/home/node/.claude/.last-known-good-bot';
const APP_DIR = '/app';

function snapshotGoodState() {
  try {
    // Ensure backup dir exists
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // Copy all .js files
    const jsFiles = fs.readdirSync(APP_DIR).filter(f => f.endsWith('.js'));
    for (const file of jsFiles) {
      fs.copyFileSync(path.join(APP_DIR, file), path.join(BACKUP_DIR, file));
    }

    // Copy subdirectories
    // Use fs.rmSync + fs.cpSync instead of execSync('rm -rf ... && cp -r ...')
    // to avoid shell command interpolation (security fix H6, 2026-04-11).
    // Inputs are hardcoded today, but template-literal interpolation into a
    // shell string is a trap waiting for the first config-driven change.
    for (const dir of ['wizards', 'personalities', 'project-template']) {
      const src = path.join(APP_DIR, dir);
      const dest = path.join(BACKUP_DIR, dir);
      if (fs.existsSync(src)) {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true });
      }
    }

    console.log(`[safe-rebuild] Snapshotted current code as last-known-good`);
  } catch (err) {
    console.error(`[safe-rebuild] Failed to snapshot:`, err.message);
  }
}

module.exports = { snapshotGoodState };
