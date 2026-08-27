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

test('payment goes directly to the merchant primary wallet', async () => {
  const key = 'lf_live_privy_payment_test';
  await store.set(`merchant:${key}`, {
    id: 'm_privy_payment_test',
    mode: 'direct',
    chains: ['eip155:1'],
    privyUserId: 'did:privy:test-merchant',
    privyWalletId: 'wallet_primary',
    privyWalletAddress: '0x2222222222222222222222222222222222222222',
    status: 'active',
  });

  const res = responseCapture();
  await paymentsHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: { amount: '1', asset: 'VERSE', chain: 'eip155:1', label: 'Direct test' },
  }, res);

  assert.equal(res.code, 201);
  assert.equal(res.body.deposit_address, '0x2222222222222222222222222222222222222222');
  const stored = await store.get(`payment:${res.body.payment_id}`);
  assert.equal(stored.walletProvider, 'PRIVY');
  assert.equal(stored.privyWalletId, 'wallet_primary');
  assert.equal(stored.mode, 'direct');
  assert.equal(stored.baselineBalance, '0');});