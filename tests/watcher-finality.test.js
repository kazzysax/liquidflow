const test = require('node:test');
const assert = require('node:assert/strict');

process.env.POLYGON_MAINNET_RPC = 'https://primary.invalid';
process.env.POLYGON_MAINNET_RPC_BACKUP = 'https://backup.test';

const recipient = '0x2222222222222222222222222222222222222222';
const payer = '0x1111111111111111111111111111111111111111';
const topic = address => '0x' + address.slice(2).toLowerCase().padStart(64, '0');
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (url.includes('primary.invalid')) throw new Error('primary unavailable');
  const request = JSON.parse(options.body);
  let result;
  if (request.method === 'eth_blockNumber') result = '0x64';
  else if (request.method === 'eth_getLogs') result = [{
    transactionHash: '0x' + 'ab'.repeat(32),
    logIndex: '0x0',
    blockNumber: '0x63',
    topics: [transferTopic, topic(payer), topic(recipient)],
    data: '0x' + (100n).toString(16).padStart(64, '0'),
  }];
  else if (request.method === 'eth_getBlockByNumber' && request.params[0] === 'finalized') result = { number: '0x63', timestamp: '0x5' };
  else if (request.method === 'eth_getBlockByNumber') result = { number: request.params[0], timestamp: '0x5' };
  else throw new Error('unexpected RPC method ' + request.method);
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
};

const chain = require('../api/_lib/chain');

test.after(() => { global.fetch = originalFetch; });

test('Polygon watcher fails over and confirms against the finalized milestone', async () => {
  const scan = await chain.scanTransfersTo({
    chain: 'eip155:137', asset: 'fxVERSE', startBlock: '90',
    depositAddress: recipient, expiresAt: Date.now() + 60_000,
  });
  assert.equal(scan.required, 1);
  assert.equal(scan.finalizedHead, '99');
  assert.equal(scan.finalized.length, 1);
  assert.equal(scan.pending.length, 0);
  assert.equal(scan.finalized[0].amount, '100');
});