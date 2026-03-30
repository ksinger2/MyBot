const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, 'core');

function parseSkillFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const instructions = fmMatch[2].trim();

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  if (!nameMatch) return null;

  return {
    name: nameMatch[1].trim(),
    description: descMatch ? descMatch[1].trim() : '',
    instructions,
  };
}

function listSkills() {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    return fs.readdirSync(SKILLS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => parseSkillFile(path.join(SKILLS_DIR, f)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getSkill(name) {
  const skills = listSkills();
  return skills.find(s => s.name === name) || null;
}

module.exports = { getSkill, listSkills };
