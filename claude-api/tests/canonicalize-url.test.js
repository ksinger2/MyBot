const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _canonicalizeUrl } = require('../plugins/product-search/ddg-scrape');

describe('_canonicalizeUrl', () => {
  describe('Amazon', () => {
    it('extracts ASIN from long URL with title slug and ref', () => {
      const url = 'https://www.amazon.com/Bose-QuietComfort-Headphones-Cancelling-Bluetooth/dp/B0CCZ26B5V/ref=sr_1_1?keywords=headphones';
      assert.equal(_canonicalizeUrl(url, 'amazon'), 'https://www.amazon.com/dp/B0CCZ26B5V');
    });

    it('normalizes already-short dp URL', () => {
      assert.equal(_canonicalizeUrl('https://amazon.com/dp/B07ZQ3LGF5', 'amazon'), 'https://www.amazon.com/dp/B07ZQ3LGF5');
    });

    it('returns original if no ASIN found', () => {
      const url = 'https://www.amazon.com/s?k=headphones';
      assert.equal(_canonicalizeUrl(url, 'amazon'), url);
    });
  });

  describe('Walmart', () => {
    it('extracts SKU from URL with product name slug', () => {
      const url = 'https://www.walmart.com/ip/Great-Value-Whole-Milk/123456789?sp_cid=abc';
      assert.equal(_canonicalizeUrl(url, 'walmart'), 'https://www.walmart.com/ip/123456789');
    });

    it('extracts SKU from URL without slug', () => {
      assert.equal(_canonicalizeUrl('https://walmart.com/ip/567890123', 'walmart'), 'https://www.walmart.com/ip/567890123');
    });

    it('returns original if no SKU found', () => {
      const url = 'https://www.walmart.com/browse/electronics';
      assert.equal(_canonicalizeUrl(url, 'walmart'), url);
    });
  });

  describe('Target', () => {
    it('extracts product ID from long URL with name and fragment', () => {
      const url = 'https://www.target.com/p/Yoga-Mat-Premium/-/A-12345678#lnk=sametab';
      assert.equal(_canonicalizeUrl(url, 'target'), 'https://www.target.com/p/-/A-12345678');
    });

    it('normalizes already-short target URL', () => {
      assert.equal(_canonicalizeUrl('https://target.com/p/-/A-87654321', 'target'), 'https://www.target.com/p/-/A-87654321');
    });

    it('returns original if no product ID found', () => {
      const url = 'https://www.target.com/c/electronics';
      assert.equal(_canonicalizeUrl(url, 'target'), url);
    });
  });

  describe('edge cases', () => {
    it('unknown store returns URL unchanged', () => {
      assert.equal(_canonicalizeUrl('https://bestbuy.com/product/123', 'bestbuy'), 'https://bestbuy.com/product/123');
    });

    it('empty string returns empty string', () => {
      assert.equal(_canonicalizeUrl('', 'amazon'), '');
    });

    it('non-URL string returns unchanged', () => {
      assert.equal(_canonicalizeUrl('not a url', 'walmart'), 'not a url');
    });
  });
});
