const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const GREETING_RE = /^[\s\p{Emoji}]*(h(i|ey|ello|ola)|yo+|sup|what'?s\s*up|good\s*(morning|evening|afternoon|night)|gm|thanks?|thank\s*you|thx|ty|ok(ay)?|cool|nice|got\s*it|bet|lol|lmao|haha)(\s+(girl|babe|there|bestie|queen|boo|hun|love|dude|man|bro|fam))?\s*[!?.♡❤️✨💕💋😘]*\s*$/iu;

describe('Greeting fast-path', () => {
  describe('should match greetings (no Claude invocation)', () => {
    const greetings = [
      'hi', 'hey', 'hello', 'hola', 'yo', 'yooo', 'sup',
      "what's up", 'whats up', 'good morning', 'good evening', 'gm',
      'thanks', 'thank you', 'thx', 'ty',
      'ok', 'okay', 'cool', 'nice', 'got it', 'bet',
      'lol', 'lmao', 'haha',
      'hey girl', 'hi there', 'hey bestie', 'sup dude',
      'Hi!', 'hey!', 'HELLO', 'Hey boo!',
      'hey ✨', 'hi 😘', 'thanks!',
    ];

    for (const g of greetings) {
      it(`matches "${g}"`, () => {
        assert.ok(GREETING_RE.test(g), `"${g}" should match greeting regex`);
      });
    }
  });

  describe('should NOT match real questions (must invoke Claude)', () => {
    const questions = [
      'hey can you check my calendar',
      'hi what is the weather',
      'hello please help me with something',
      'hey girl what are we doing tonight',
      'thanks for checking, can you also look at my email',
      'ok so now fix the bug',
      'hey whats the status of the build',
      'good morning, any updates?',
      'put a brunch on my calendar',
      'run the fortnite script',
      '!ls',
      '!btw',
      'what time is my meeting tomorrow',
    ];

    for (const q of questions) {
      it(`does NOT match "${q}"`, () => {
        assert.ok(!GREETING_RE.test(q), `"${q}" should NOT match greeting regex`);
      });
    }
  });
});
