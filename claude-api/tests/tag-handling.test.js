const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Tag stripping', () => {
  // The streaming regex from runner.js — kept in sync here for regression testing
  const STRIP_RE = /\[(LEARNED|IMAGINE|CALENDAR|WEATHER|PRODUCT|REMIND|REBUILD|EVENT|EVENT_JOIN|SET_PREF|UPDATE_NOTES|BACKGROUND|CONCERT_PRICES|FLIGHT_SEARCH|FLIGHT_PRICE|EIGHTSLEEP|NEEDS_AGENT)[:|\]][^\]]*\]?/gi;

  describe('strips action tags from streamed output', () => {
    const tags = [
      '[LEARNED: user prefers morning meetings]',
      '[IMAGINE: a sunset over the ocean]',
      '[CALENDAR: fromDate="2026-05-01" toDate="2026-05-07"]',
      '[WEATHER: location="San Francisco"]',
      '[REMIND: title="standup" datetime="2026-05-01T09:00:00"]',
      '[REBUILD]',
      '[EVENT: title="Brunch" datetime="2026-05-03T11:00:00"]',
      '[SET_PREF: domain="events" match="brunch" duration_minutes=120]',
      '[BACKGROUND: research task | do some research]',
      '[NEEDS_AGENT]',
      '[PRODUCT: wireless headphones]',
      '[EIGHTSLEEP: status]',
    ];

    for (const tag of tags) {
      it(`strips "${tag.substring(0, 40)}..."`, () => {
        const result = `Here is your answer ${tag} and more text`.replace(STRIP_RE, '');
        assert.ok(!result.includes('['), `Tag should be stripped: ${result}`);
      });
    }
  });

  describe('does NOT strip non-tag brackets', () => {
    const safe = [
      'Use [bracket notation] for arrays',
      'The array is [1, 2, 3]',
      'See [this link](url)',
      'npm install [package]',
    ];

    for (const text of safe) {
      it(`preserves "${text.substring(0, 40)}"`, () => {
        const result = text.replace(STRIP_RE, '');
        assert.equal(result, text, 'Non-tag brackets should be preserved');
      });
    }
  });
});

describe('Tag regex captures', () => {
  describe('[EVENT:] tag parsing', () => {
    const EVENT_RE = /\[EVENT:\s*(.*?)\]/s;

    it('captures event parameters', () => {
      const text = '[EVENT: title="Brunch" datetime="2026-05-03T11:00:00" duration_minutes=120 location="Cafe"]';
      const match = text.match(EVENT_RE);
      assert.ok(match, 'Should match EVENT tag');
      assert.ok(match[1].includes('title="Brunch"'));
      assert.ok(match[1].includes('datetime='));
    });
  });

  describe('[CALENDAR:] tag parsing', () => {
    const CAL_RE = /\[CALENDAR:\s*(.*?)\]/s;

    it('captures date range', () => {
      const text = '[CALENDAR: fromDate="2026-05-01" toDate="2026-05-07"]';
      const match = text.match(CAL_RE);
      assert.ok(match, 'Should match CALENDAR tag');
      assert.ok(match[1].includes('fromDate='));
    });
  });
});
