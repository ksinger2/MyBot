const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CALENDAR_INTENT, WEATHER_INTENT, IMAGINE_INTENT, REMIND_INTENT, EIGHTSLEEP_INTENT } = require('../auto-context');

describe('auto-context intent detection', () => {
  describe('IMAGINE_INTENT', () => {
    const shouldMatch = [
      'draw me a cat',
      'generate an image of a sunset',
      'make a picture of a dog',
      'create a portrait of her',
      'can you sketch me something',
      'design a logo for my company',
      'show me what a dragon looks like',
      'picture of a beach',
      'I want an illustration of a castle',
      'paint me something cool',
    ];
    const shouldNotMatch = [
      'what does my schedule look like',
      'picture this: we go to dinner',
      'I drew a blank on that',
      'make a reservation',
      'can you imagine how tired I am',
    ];

    for (const text of shouldMatch) {
      it(`matches: "${text}"`, () => {
        assert.ok(IMAGINE_INTENT.test(text), `Expected match: "${text}"`);
      });
    }
    for (const text of shouldNotMatch) {
      it(`does not match: "${text}"`, () => {
        assert.ok(!IMAGINE_INTENT.test(text), `Expected no match: "${text}"`);
      });
    }
  });

  describe('REMIND_INTENT', () => {
    const shouldMatch = [
      'remind me to call mom tomorrow',
      'set a reminder for 5pm',
      'don\'t let me forget to buy milk',
      'remind me at 3pm',
      'can you set an alarm for 7am',
      'remind us to check in later',
      'dont forget to water the plants — remind me',
    ];
    const shouldNotMatch = [
      'that reminds me of something',
      'this is a reminder of the past',
      'the alarm went off',
      'remember when we went there',
    ];

    for (const text of shouldMatch) {
      it(`matches: "${text}"`, () => {
        assert.ok(REMIND_INTENT.test(text), `Expected match: "${text}"`);
      });
    }
    for (const text of shouldNotMatch) {
      it(`does not match: "${text}"`, () => {
        assert.ok(!REMIND_INTENT.test(text), `Expected no match: "${text}"`);
      });
    }
  });

  describe('EIGHTSLEEP_INTENT', () => {
    const shouldMatch = [
      'turn off my bed',
      'how warm is my bed',
      'set the bed to level 3',
      'eight sleep status',
      'turn on the pod',
      'make my side cooler',
      'what\'s my bed temperature',
      'switch off the mattress',
    ];
    const shouldNotMatch = [
      'I went to bed early',
      'time for bed',
      'bed bath and beyond',
      'I slept well',
    ];

    for (const text of shouldMatch) {
      it(`matches: "${text}"`, () => {
        assert.ok(EIGHTSLEEP_INTENT.test(text), `Expected match: "${text}"`);
      });
    }
    for (const text of shouldNotMatch) {
      it(`does not match: "${text}"`, () => {
        assert.ok(!EIGHTSLEEP_INTENT.test(text), `Expected no match: "${text}"`);
      });
    }
  });
});
