const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISABLE_VERSE_ANALYTICS = '1';

const store = require('../api/_lib/store');
const chain = require('../api/_lib/chain');
const privy = require('../api/_lib/privy');
chain.currentBlock = async () => 123456n;
chain.confirmedBalance = async () => 0n;
const paymentsHandler = require('../api/payments');

function responseCapture() {
  return {
    code: 200,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test('payment rotates through the merchant payment-wallet pool', async () => {
  const key = 'lf_live_privy_payment_test';
  await store.set(`merchant:${key}`, {
    id: 'm_privy_payment_test',
    mode: 'wallet_pool',
    chains: ['eip155:1'],
    privyUserId: 'did:privy:test-merchant',
    privyWalletId: 'wallet_primary',
    privyWalletAddress: '0x2222222222222222222222222222222222222222',
    privyPaymentWallets: Array.from({ length: 10 }, (_, index) => ({ walletId: 'wallet_pool_' + (index + 1), walletAddress: '0x' + String(index + 3).padStart(40, '0'), slot: index + 1 })),
    status: 'active',
  });

  const res = responseCapture();
  await paymentsHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: { amount: '1', asset: 'VERSE', chain: 'eip155:1', label: 'Direct test' },
  }, res);

  assert.equal(res.code, 201);
  assert.equal(res.body.deposit_address, '0x0000000000000000000000000000000000000003');
  const stored = await store.get(`payment:${res.body.payment_id}`);
  assert.equal(stored.walletProvider, 'PRIVY_POOL');
  assert.equal(stored.privyWalletId, 'wallet_pool_1');
  assert.equal(stored.mode, 'wallet_pool');
  assert.equal(stored.baselineBalance, '0');});
test('existing Privy merchant is lazily migrated to a 10-wallet pool', async () => {
  const key = 'lf_live_legacy_pool_migration';
  const original = privy.provisionPaymentPool;
  const pool = Array.from({ length: 10 }, (_, index) => ({
    walletId: 'wallet_migrated_' + (index + 1),
    walletAddress: '0x' + String(index + 60).padStart(40, '0'),
    slot: index + 1,
  }));
  privy.provisionPaymentPool = async (userId, merchantId) => {
    assert.equal(userId, 'did:privy:legacy-owner');
    assert.equal(merchantId, 'm_legacy_pool');
    return pool;
  };
  await store.set(`merchant:${key}`, {
    id: 'm_legacy_pool',
    mode: 'direct',
    chains: ['eip155:1'],
    privyUserId: 'did:privy:legacy-owner',
    privyWalletId: 'wallet_legacy_primary',
    privyWalletAddress: '0x7777777777777777777777777777777777777777',
    status: 'active',
  });
  const res = responseCapture();
  try {
    await paymentsHandler({
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: { amount: '2', asset: 'VERSE', chain: 'eip155:1', label: 'Migration test' },
    }, res);
  } finally {
    privy.provisionPaymentPool = original;
  }
  assert.equal(res.code, 201);
  assert.equal(res.body.deposit_address, pool[0].walletAddress);
  const merchant = await store.get(`merchant:${key}`);
  assert.equal(merchant.mode, 'wallet_pool');
  assert.equal(merchant.privyPaymentWallets.length, 10);
});