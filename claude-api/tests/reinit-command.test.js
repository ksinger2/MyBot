const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isCommandLike } = require('../command-utils');
const { buildReinitPrompt } = require('../reinit-prompt');
const reinitCommand = require('../commands/reinit');

describe('reinit command helpers', () => {
  describe('isCommandLike', () => {
    for (const text of ['!help', '/reinit', ' /reinit now', '@bot /reinit']) {
      it(`matches command-like text: "${text}"`, () => {
        const probe = text === '@bot /reinit' ? text.replace(/^@\S+\s+/, '') : text;
        assert.equal(isCommandLike(probe), true);
      });
    }

    for (const text of ['hello there', 'reinit please', 'status?', ' / not a command', '/home/user/file.txt', '/tmp/foo', '/usr/bin/node']) {
      it(`does not match non-command text: "${text}"`, () => {
        assert.equal(isCommandLike(text), false);
      });
    }
  });

  it('builds a reinit prompt that enforces NextSteps-first and domain review', () => {
    const prompt = buildReinitPrompt('/workspace/MyBot');
    assert.match(prompt, /Read `NextSteps\.md` first\./);
    assert.match(prompt, /Launch ALL of the following in parallel:/);
    assert.match(prompt, /Each agent must read the files relevant to its domain/);
    assert.match(prompt, /Do not make code changes/);
    assert.match(prompt, /Now \/ Next \/ Later/);
  });
});

describe('/reinit command module', () => {
  it('registers slash name and bang alias', () => {
    assert.equal(reinitCommand.name, '/reinit');
    assert.deepEqual(reinitCommand.aliases, ['!reinit']);
    assert.match(reinitCommand.description, /project context/i);
  });

  it('rejects invocation while busy', async () => {
    const replies = [];
    const message = {
      reply: async (text) => { replies.push(text); },
      channel: { id: 'signal:test' },
    };
    const state = { busy: true };

    await reinitCommand.run(message, '', state, {});

    assert.deepEqual(replies, ['Claude is still working. Use `!stop` first.']);
  });
});
