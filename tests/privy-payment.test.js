const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISABLE_VERSE_ANALYTICS = '1';

const store = require('../api/_lib/store');
const chain = require('../api/_lib/chain');
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

async function createPayment(key) {
  const res = responseCapture();
  await paymentsHandler({ method: 'POST', headers: { authorization: 'Bearer ' + key }, body: { amount: '1', asset: 'VERSE', chain: 'eip155:1', label: 'Direct test' } }, res);
  return res;
}

test('payment goes to the primary wallet and ignores a legacy payment pool', async () => {
  const key = 'lf_live_privy_payment_test';
  await store.set('merchant:' + key, { id: 'm_privy_payment_test', mode: 'wallet_pool', chains: ['eip155:1'], privyUserId: 'did:privy:test-merchant', privyWalletId: 'wallet_primary', privyWalletAddress: '0x2222222222222222222222222222222222222222', privyPaymentWallets: [{ walletId: 'wallet_pool_1', walletAddress: '0x3333333333333333333333333333333333333333', slot: 1 }], status: 'active' });
  const res = await createPayment(key);
  assert.equal(res.code, 201);
  assert.equal(res.body.deposit_address, '0x2222222222222222222222222222222222222222');
  assert.equal(res.body.delivery_mode, 'direct_primary');
  const stored = await store.get('payment:' + res.body.payment_id);
  assert.equal(stored.walletProvider, 'PRIVY_PRIMARY');
  assert.equal(stored.privyWalletId, 'wallet_primary');
  assert.equal(stored.mode, 'direct_primary');
  assert.equal(stored.consolidation, null);
  assert.equal(stored.baselineBalance, '0');
});

test('merchant without a wallet pool receives payment at the primary wallet', async () => {
  const key = 'lf_live_direct_primary';
  await store.set('merchant:' + key, { id: 'm_direct_primary', mode: 'direct_primary', chains: ['eip155:1'], privyUserId: 'did:privy:direct-owner', privyWalletId: 'wallet_direct', privyWalletAddress: '0x7777777777777777777777777777777777777777', status: 'active' });
  const res = await createPayment(key);
  assert.equal(res.code, 201);
  assert.equal(res.body.deposit_address, '0x7777777777777777777777777777777777777777');
  assert.equal(res.body.delivery_mode, 'direct_primary');
});
