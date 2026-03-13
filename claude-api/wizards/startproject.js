const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { startWizard } = require('../wizard');

const TEMPLATE_DIR = path.join(__dirname, '..', 'project-template');

function startProjectWizard(state, message) {
  return startWizard(state, message, {
    type: 'startproject',
    steps: [
      {
        key: 'name',
        prompt: 'What\'s the project name? (no spaces, e.g. `my-cool-app`)',
        validate: (input) => {
          if (!input || input.length === 0) return 'Project name cannot be empty.';
          if (/\s/.test(input)) return 'No spaces allowed in project name. Use hyphens instead (e.g. `my-app`).';
          if (!/^[a-zA-Z0-9._-]+$/.test(input)) return 'Only letters, numbers, hyphens, underscores, and dots allowed.';
          return true;
        },
      },
      {
        key: 'location',
        prompt: 'Where should I create it? (full path, or press enter for `/workspace`)',
        default: '/workspace',
        validate: (input) => {
          if (!fs.existsSync(input)) return `Directory \`${input}\` doesn't exist. Enter a valid path.`;
          if (!fs.statSync(input).isDirectory()) return `\`${input}\` is not a directory.`;
          return true;
        },
      },
      {
        key: 'gitSetup',
        prompt: 'Git setup?\n`1` — Create a new private GitHub repo\n`2` — Use an existing repo URL\n`3` — No git\n\nReply with **1**, **2**, or **3**.',
        validate: (input) => {
          if (!['1', '2', '3'].includes(input)) return 'Reply with **1**, **2**, or **3**.';
          return true;
        },
      },
      {
        key: 'repoUrl',
        prompt: 'Paste the repo URL (e.g. `https://github.com/user/repo.git`):',
        condition: (data) => data.gitSetup === '2',
        validate: (input) => {
          if (!input || input.length === 0) return 'Repo URL cannot be empty.';
          if (!input.includes('github.com') && !input.includes('gitlab.com') && !input.includes('bitbucket.org') && !input.endsWith('.git')) {
            return 'That doesn\'t look like a repo URL. Send a GitHub/GitLab/Bitbucket URL.';
          }
          return true;
        },
      },
    ],
    onComplete: async (data, msg, channelState) => {
      await executeProjectSetup(data, msg, channelState);
    },
  });
}

async function executeProjectSetup(data, message, channelState) {
  const fullPath = path.join(data.location, data.name);

  try {
    // Check if directory already exists
    if (fs.existsSync(fullPath)) {
      await message.reply(`Directory \`${fullPath}\` already exists. Choose a different name or location.`);
      return;
    }

    await message.reply(`Setting up **${data.name}**... this may take a moment.`);

    // 1. Create project directory
    fs.mkdirSync(fullPath, { recursive: true });

    // 2. Copy template files
    if (fs.existsSync(TEMPLATE_DIR)) {
      copyDirSync(TEMPLATE_DIR, fullPath);
    } else {
      // Fallback: create minimal structure
      fs.mkdirSync(path.join(fullPath, '.claude', 'agents'), { recursive: true });
      fs.mkdirSync(path.join(fullPath, '.claude', 'commands'), { recursive: true });
      fs.mkdirSync(path.join(fullPath, '.claude', 'skills'), { recursive: true });
    }

    // 3. Replace placeholders in template files
    replacePlaceholders(fullPath, { '{{PROJECT_NAME}}': data.name });

    // 4. Git setup
    let gitStatus = '';
    const execOpts = { cwd: fullPath, encoding: 'utf-8', timeout: 30000 };

    if (data.gitSetup === '1') {
      // New private GitHub repo
      try {
        execSync('git init', execOpts);
        execSync('git add .', execOpts);
        execSync(`git commit -m "Initial project setup with Claude Code template"`, execOpts);
        const ghOutput = execSync(
          `gh repo create ${data.name} --private --source=. --push 2>&1`,
          execOpts
        ).trim();
        gitStatus = `\nGitHub repo created (private): ${ghOutput}`;
      } catch (err) {
        gitStatus = `\n⚠️ Git init succeeded but GitHub repo creation failed: ${err.message.substring(0, 200)}`;
      }
    } else if (data.gitSetup === '2') {
      // Existing repo
      try {
        execSync('git init', execOpts);
        execSync(`git remote add origin ${data.repoUrl}`, execOpts);
        execSync('git add .', execOpts);
        execSync(`git commit -m "Initial project setup with Claude Code template"`, execOpts);
        execSync('git push -u origin main 2>&1', execOpts);
        gitStatus = `\nPushed to: ${data.repoUrl}`;
      } catch (err) {
        gitStatus = `\n⚠️ Git push failed: ${err.message.substring(0, 200)}\nYou may need to push manually.`;
      }
    } else {
      gitStatus = '\nNo git setup.';
    }

    // 5. Update channel working directory
    channelState.cwd = fullPath;
    channelState.sessionId = null;

    // 6. Report success
    const fileList = listProjectFiles(fullPath);
    await message.reply(
      `**Project "${data.name}" created!** 🎉\n` +
      `📁 Location: \`${fullPath}\`\n` +
      `Working directory updated.${gitStatus}\n\n` +
      `**Template files:**\n${fileList}\n\n` +
      `Start building — just type what you want to create!`
    );
  } catch (err) {
    await message.reply(`Project setup failed: ${err.message}`);
  }
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function replacePlaceholders(dir, replacements) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      replacePlaceholders(fullPath, replacements);
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.txt') || entry.name.endsWith('.json')) {
      let content = fs.readFileSync(fullPath, 'utf-8');
      for (const [placeholder, value] of Object.entries(replacements)) {
        content = content.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
      }
      fs.writeFileSync(fullPath, content);
    }
  }
}

function listProjectFiles(dir, prefix = '') {
  const lines = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      lines.push(`${prefix}📁 ${entry.name}/`);
      lines.push(...listProjectFiles(path.join(dir, entry.name), prefix + '  ').split('\n').filter(Boolean));
    } else {
      lines.push(`${prefix}📄 ${entry.name}`);
    }
  }
  return lines.join('\n');
}

module.exports = { startProjectWizard };
