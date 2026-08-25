const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISABLE_VERSE_ANALYTICS = '1';

const store = require('../api/_lib/store');
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
      chains: ['eip155:1'],
      settle: 'VERSE',
      mode: 'stealth',
      payout: '',
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
  assert.ok(res.body.spend_key);
  assert.ok(res.body.view_key);
});

test('legacy pending merchant keys are released without payment', async () => {
  const key = 'lf_live_legacy_subscription';
  await store.set(`merchant:${key}`, {
    id: 'm_legacy',
    name: 'Legacy Merchant',
    status: 'pending_activation',
    onboardingPaymentId: 'pay_old_subscription',
    mode: 'stealth',
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
