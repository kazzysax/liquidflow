const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const dex = require('../api/_lib/verse-dex');

const wallet = '0x1111111111111111111111111111111111111111';

test('DEX routes pin only the approved mainnet routers and canonical tokens', () => {
  const eth = dex.ROUTES['eip155:1'], polygon = dex.ROUTES['eip155:137'];
  assert.equal(eth.router, '0xB4B0ea46Fe0E9e8EAB4aFb765b527739F2718671');
  assert.equal(eth.tokens.VERSE.address.toLowerCase(), '0x249ca82617ec3dfb2589c4c17ab7ec9765350a18');
  assert.equal(polygon.router.toLowerCase(), '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff');
  assert.equal(polygon.tokens.FXVERSE.address.toLowerCase(), '0xc708d6f2153933daa50b2d0758955be0a93a8fec');
  assert.equal(Object.keys(dex.ROUTES).length, 2);
});

test('Polygon fxVERSE candidates include the live WMATIC route', () => {
  const cfg = dex.ROUTES['eip155:137'];
  const paths = dex.candidatePaths(cfg, cfg.tokens.FXVERSE, cfg.tokens.USDC);
  assert.ok(paths.some(path => path[1] && path[1].toLowerCase() === cfg.wrapped.toLowerCase()));
});

test('quote validation rejects arbitrary tokens, excessive slippage and unsupported chains', () => {
  assert.throws(() => dex.validate({ chain: 'eip155:8453', from: 'VERSE', to: 'USDC', amount: '1', recipient: wallet }));
  assert.throws(() => dex.validate({ chain: 'eip155:1', from: 'DAI', to: 'USDC', amount: '1', recipient: wallet }));
  assert.throws(() => dex.validate({ chain: 'eip155:1', from: 'VERSE', to: 'USDC', amount: '1', recipient: wallet, slippage_bps: 301 }));
});

test('swap plan uses exact approval, protected minimum output and a bounded deadline', () => {
  const cfg = dex.ROUTES['eip155:1'], amountIn = 10n ** 18n, amountOut = 25000n;
  const plan = dex.buildPlan({ cfg, input: cfg.tokens.VERSE, output: cfg.tokens.USDC, amountIn, amountOut,
    path: [cfg.tokens.VERSE.address, cfg.tokens.USDC.address], recipient: wallet, bps: 50,
    deadline: 2000, blockNumber: 100, pools: [], priceImpactBps: 35, allowance: 0n });
  assert.equal(plan.output.minimum_amount, '24875');
  assert.equal(plan.deadline, 2000);
  assert.equal(plan.steps.length, 2);
  const erc20 = new ethers.Interface(['function approve(address,uint256) returns(bool)']);
  const decoded = erc20.decodeFunctionData('approve', plan.steps[0].data);
  assert.equal(decoded[0].toLowerCase(), cfg.router.toLowerCase());
  assert.equal(decoded[1], amountIn);
});

test('existing exact-or-higher allowance removes the approval transaction', () => {
  const cfg = dex.ROUTES['eip155:1'];
  const plan = dex.buildPlan({ cfg, input: cfg.tokens.USDC, output: cfg.tokens.VERSE, amountIn: 1000000n, amountOut: 10n ** 18n,
    path: [cfg.tokens.USDC.address, cfg.tokens.VERSE.address], recipient: wallet, bps: 50,
    deadline: 2000, blockNumber: 100, pools: [], priceImpactBps: 35, allowance: 1000000n });
  assert.equal(plan.steps.length, 1);
  assert.match(plan.steps[0].label, /^swap /);
});
