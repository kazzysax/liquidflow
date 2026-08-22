const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const chain = require('../api/_lib/chain');
const cctp = require('../api/_lib/cctp');

test('customer checkout expiration is exactly ten minutes', () => {
  assert.equal(chain.CHECKOUT_TTL_MS, 10 * 60 * 1000);
});

test('asset allowlist is limited to the agreed mainnet matrix', () => {
  assert.equal(chain.assetConfig('eip155:1', 'VERSE').decimals, 18);
  assert.equal(chain.assetConfig('eip155:1', 'USDC').decimals, 6);
  assert.equal(chain.assetConfig('eip155:137', 'VERSE').symbol, 'fxVERSE');
  assert.equal(chain.assetConfig('eip155:137', 'fxVERSE').symbol, 'fxVERSE');
  assert.equal(chain.assetConfig('eip155:137', 'USDC').decimals, 6);
  assert.equal(chain.assetConfig('eip155:8453', 'USDC').decimals, 6);
  assert.equal(chain.assetConfig('eip155:8453', 'VERSE'), null);
  assert.equal(chain.assetConfig('eip155:11155111', 'USDC'), null);
  assert.equal(chain.assetConfig('eip155:1', 'USDT'), null);
});

test('canonical USDC contracts match Circle mainnet addresses', () => {
  assert.equal(chain.assetConfig('eip155:1', 'USDC').contract, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  assert.equal(chain.assetConfig('eip155:137', 'USDC').contract, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
  assert.equal(chain.assetConfig('eip155:8453', 'USDC').contract, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
});

test('CCTP burn plan pins mainnet contracts, destination and amount', () => {
  const recipient = '0x1111111111111111111111111111111111111111';
  const plan = cctp.buildBurnPlan({ from: 'eip155:1', to: 'eip155:8453', amount: '1000000', recipient });
  assert.equal(plan.source.token_messenger, cctp.TOKEN_MESSENGER);
  assert.equal(plan.destination.domain, 6);
  const iface = new ethers.Interface(['function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)']);
  const decoded = iface.decodeFunctionData('depositForBurn', plan.source.steps[1].data);
  assert.equal(decoded[0], 1000000n);
  assert.equal(decoded[1], 6n);
  assert.equal(decoded[3], cctp.CHAINS['eip155:1'].usdc);
  assert.equal(decoded[5], 0n);
  assert.equal(decoded[6], 2000n);
});

test('CCTP rejects testnets and unsafe amounts', () => {
  const recipient = '0x1111111111111111111111111111111111111111';
  assert.throws(() => cctp.buildBurnPlan({ from: 'eip155:11155111', to: 'eip155:1', amount: '1', recipient }), /unsupported source/);
  assert.throws(() => cctp.buildBurnPlan({ from: 'eip155:1', to: 'eip155:137', amount: '0', recipient }), /positive integer/);
  assert.throws(() => cctp.buildBurnPlan({ from: 'eip155:1', to: 'eip155:137', amount: '1e6', recipient }), /positive integer/);
});

test('CCTP attestation lookup rejects domains outside the mainnet allowlist', async () => {
  await assert.rejects(
    cctp.getAttestation(26, '0x' + '11'.repeat(32)),
    /unsupported source CCTP domain/
  );
});
