const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cleanProductQuery } = require('../commands/product');

describe('cleanProductQuery', () => {
  it('strips conversational filler and extracts store', () => {
    const r = cleanProductQuery('add a nice and good deal product to my amazon cart that is a planter, 8 ft long');
    assert.equal(r.query, 'planter, 8 ft long');
    assert.equal(r.preferredStore, 'amazon');
  });

  it('extracts walmart store preference', () => {
    const r = cleanProductQuery('find me a good deal on walmart for protein powder');
    assert.equal(r.preferredStore, 'walmart');
    assert.ok(!r.query.includes('walmart'));
  });

  it('extracts target store preference', () => {
    const r = cleanProductQuery('search on target for a yoga mat');
    assert.equal(r.preferredStore, 'target');
    assert.ok(r.query.includes('yoga mat'));
  });

  it('returns null preferredStore when no store mentioned', () => {
    const r = cleanProductQuery('airpods pro 2');
    assert.equal(r.preferredStore, null);
    assert.equal(r.query, 'airpods pro 2');
  });

  it('preserves brand name "Good Earth"', () => {
    const r = cleanProductQuery('Good Earth tea');
    assert.ok(r.query.includes('Good Earth'));
  });

  it('preserves brand name "Best Buy" (not at start of query)', () => {
    const r = cleanProductQuery('laptop from Best Buy');
    assert.ok(r.query.includes('Best Buy'));
  });

  it('strips "i want you to buy" wrapper', () => {
    const r = cleanProductQuery('i want you to buy a standing desk');
    assert.ok(r.query.includes('standing desk'));
    assert.ok(!r.query.match(/^i want/i));
  });

  it('strips "find me" prefix', () => {
    const r = cleanProductQuery('find me a wireless mouse');
    assert.ok(r.query.includes('wireless mouse'));
  });

  it('passes through already-clean queries unchanged', () => {
    const r = cleanProductQuery('dove 0% aluminum deodorant');
    assert.equal(r.query, 'dove 0% aluminum deodorant');
    assert.equal(r.preferredStore, null);
  });

  it('falls back to raw input when stripping leaves empty', () => {
    const r = cleanProductQuery('add');
    assert.ok(r.query.length > 0);
  });

  it('strips "to my amazon cart" phrase', () => {
    const r = cleanProductQuery('add protein bars to my amazon cart');
    assert.ok(!r.query.includes('amazon'));
    assert.ok(!r.query.includes('cart'));
    assert.ok(r.query.includes('protein bars'));
    assert.equal(r.preferredStore, 'amazon');
  });

  it('strips "a nice and good deal product" filler', () => {
    const r = cleanProductQuery('a nice and good deal product that is a blender');
    assert.ok(r.query.includes('blender'));
    assert.ok(!r.query.match(/nice.*good.*deal/i));
  });
});
