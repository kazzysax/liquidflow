const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitize, trackVerseEvent } = require('../api/_lib/verse-analytics');

test('Verse Analytics properties exclude nested or sensitive-shaped values', () => {
  const clean = sanitize({
    asset: 'VERSE',
    chain: 'eip155:1',
    count: 1,
    enabled: true,
    wallet: { address: '0xsecret' },
    list: ['not', 'allowed'],
  });
  assert.deepEqual(clean, {
    asset: 'VERSE',
    chain: 'eip155:1',
    count: '1',
    enabled: 'true',
  });
});

test('Verse Analytics outages never interrupt payment processing', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('analytics unavailable'); };
  try {
    assert.equal(await trackVerseEvent('Payment Created', { asset: 'VERSE' }), false);
  } finally {
    global.fetch = originalFetch;
  }
});
