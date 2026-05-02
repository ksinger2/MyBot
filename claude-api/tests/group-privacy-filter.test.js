const { describe, it } = require('node:test');
const assert = require('node:assert');
const { filterGroupOutput, PHONE_RE, EMAIL_RE } = require('../group-privacy-filter');

describe('group-privacy-filter', () => {
  it('redacts phone numbers from group chat responses', () => {
    const input = 'You can reach Karen at +14155551234 for details.';
    const { text, redactions } = filterGroupOutput(input, { senderPhone: '+19165559999' });
    assert.ok(!text.includes('+14155551234'));
    assert.ok(text.includes('[redacted]'));
    assert.strictEqual(redactions.length, 1);
  });

  it('does not redact the sender\'s own number', () => {
    const input = 'Your number is +14155551234.';
    const { text, redactions } = filterGroupOutput(input, { senderPhone: '+14155551234' });
    assert.ok(text.includes('+14155551234'));
    assert.strictEqual(redactions.length, 0);
  });

  it('redacts email addresses', () => {
    const input = 'Send it to karen@example.com and she will forward it.';
    const { text, redactions } = filterGroupOutput(input, {});
    assert.ok(!text.includes('karen@example.com'));
    assert.ok(text.includes('[redacted]'));
    assert.strictEqual(redactions.length, 1);
  });

  it('redacts profile dump lines', () => {
    const input = 'Here is their info:\nname: Karen Singer\nphone: +14155551234\nemail: karen@test.com\nShe lives nearby.';
    const { text, redactions } = filterGroupOutput(input, {});
    assert.ok(!text.includes('Karen Singer'));
    assert.ok(!text.includes('+14155551234'));
    assert.ok(!text.includes('karen@test.com'));
    assert.ok(text.includes('She lives nearby'));
    assert.ok(redactions.length >= 2);
  });

  it('handles empty/null input gracefully', () => {
    assert.deepStrictEqual(filterGroupOutput(''), { text: '', redactions: [] });
    assert.deepStrictEqual(filterGroupOutput(null), { text: '', redactions: [] });
  });

  it('does not redact non-phone numbers (years, IDs, etc.)', () => {
    const input = 'The event is in 2026 and ticket #12345 is confirmed.';
    const { text, redactions } = filterGroupOutput(input, {});
    assert.ok(text.includes('2026'));
    assert.ok(text.includes('#12345'));
    assert.strictEqual(redactions.length, 0);
  });

  it('redacts multiple phone numbers in one message', () => {
    const input = 'Call +14155551234 or (510) 555-7890 for info.';
    const { text, redactions } = filterGroupOutput(input, { senderPhone: '+19999999999' });
    assert.ok(!text.includes('+14155551234'));
    assert.ok(!text.includes('555-7890'));
    assert.strictEqual(redactions.length, 2);
  });
});
