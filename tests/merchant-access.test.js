const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISABLE_VERSE_ANALYTICS = '1';

const store = require('../api/_lib/store');
const privy = require('../api/_lib/privy');
privy.provisionMerchant = async (email, merchantId) => ({
  userId: 'did:privy:test-merchant',
  walletId: 'wallet_test_merchant',
  walletAddress: '0x2222222222222222222222222222222222222222',
  paymentWallets: Array.from({ length: 10 }, (_, index) => ({ walletId: 'wallet_signup_' + (index + 1), walletAddress: '0x' + String(index + 40).padStart(40, '0'), slot: index + 1 })),
});
const merchantHandler = require('../api/merchants');
const { checkAndConfirm } = require('../api/_lib/chain');

function responseCapture() {
  return {
    code: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test('new merchant gateways activate immediately without a subscription invoice', async () => {
  const req = {
    method: 'POST',
    headers: {},
    body: {
      name: 'Audit Merchant',
      email: 'merchant@example.com',
      chains: ['eip155:1'],
      settle: 'USDC',
      mode: 'direct',
      unify: true,
      dex: 'LIQUIDFLOW_APPROVED_ROUTES',
      webhook: 'https://example.com/api/liquidflow/webhook',
    },
  };
  const res = responseCapture();
  await merchantHandler(req, res);

  assert.equal(res.code, 201);
  assert.equal(res.body.status, 'active');
  assert.equal('onboarding' in res.body, false);
  assert.equal('plan' in res.body, false);
  assert.match(res.body.api_key, /^lf_live_/);
  assert.equal('spend_key' in res.body, false);
  assert.equal('view_key' in res.body, false);
  assert.equal(res.body.settlement.provider, 'PRIVY');
  assert.equal(res.body.settlement.primary_wallet, '0x2222222222222222222222222222222222222222');
  assert.equal(res.body.settlement.sweep_wallet, null);
  assert.equal(res.body.settlement.payment_wallet_count, 10);
  assert.equal(res.body.mode, 'wallet_pool');
  assert.equal(res.body.settlement.control, 'merchant_only');
});

test('signup fails closed when the merchant wallet cannot be provisioned', async () => {
  const provision = privy.provisionMerchant;
  privy.provisionMerchant = async () => null;
  const res = responseCapture();
  try {
    await merchantHandler({
      method: 'POST',
      headers: {},
      body: {
        name: 'No Wallet Merchant',
        email: 'nowallet@example.com',
        chains: ['eip155:1'],
        settle: 'AS_RECEIVED',
        mode: 'direct',
        unify: false,
        webhook: 'https://example.com/webhook',
      },
    }, res);
  } finally {
    privy.provisionMerchant = provision;
  }
  assert.equal(res.code, 503);
  assert.match(res.body.error, /wallet service is unavailable/);
});
test('legacy pending merchant keys are released without payment', async () => {
  const key = 'lf_live_legacy_subscription';
  await store.set(`merchant:${key}`, {
    id: 'm_legacy',
    name: 'Legacy Merchant',
    status: 'pending_activation',
    onboardingPaymentId: 'pay_old_subscription',
    mode: 'direct',
    chains: ['eip155:1'],
    createdAt: 1,
  });

  const res = responseCapture();
  await merchantHandler({ method: 'GET', headers: { authorization: `Bearer ${key}` } }, res);
  const stored = await store.get(`merchant:${key}`);

  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'active');
  assert.equal('onboarding' in res.body, false);
  assert.equal(stored.status, 'active');
  assert.equal('onboardingPaymentId' in stored, false);
});

test('legacy subscription invoices are cancelled without checking the chain', async () => {
  const payment = {
    id: 'pay_old_subscription',
    onboarding: true,
    status: 'awaiting_payment',
    amount: '5000000',
  };
  await store.sadd('payments:pending', payment.id);
  await checkAndConfirm(payment);

  assert.equal(payment.status, 'cancelled');
  assert.deepEqual(await store.smembers('payments:pending'), []);
});
