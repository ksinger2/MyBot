const fs = require('fs');
const path = require('path');

/**
 * Load all command modules from this directory.
 * Each file exports { name, aliases?, adminOnly?, description, run(message, arg, state, ctx) }.
 * Returns a Map keyed by command name and aliases.
 */
function loadCommands() {
  const cmds = new Map();
  const dir = __dirname;
  for (const file of fs.readdirSync(dir)) {
    if (file === 'index.js' || !file.endsWith('.js')) continue;
    const cmd = require(path.join(dir, file));
    cmds.set(cmd.name, cmd);
    for (const alias of (cmd.aliases || [])) cmds.set(alias, cmd);
  }
  return cmds;
}

module.exports = { loadCommands };
