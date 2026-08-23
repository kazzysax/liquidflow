const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_lib/store');
const recoverHandler = require('../api/payments/recover');

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

test('authenticated recovery returns view key and canonical ERC-20 sweep metadata', async () => {
  const key = 'lf_live_audit_recovery';
  const paymentId = 'pay_audit_recovery';
  await store.set(`merchant:${key}`, { id: 'm_audit', mode: 'stealth', k_view: '11'.repeat(32) });
  await store.set(`payment:${paymentId}`, {
    id: paymentId,
    mode: 'stealth',
    status: 'confirmed',
    R: '22'.repeat(64),
    chain: 'eip155:8453',
    asset: 'USDC',
    depositAddress: '0x1111111111111111111111111111111111111111',
    amount: '1000000',
    confirmedAt: 1,
  });
  await store.sadd(`merchant:${key}:payments`, paymentId);
  const req = { method: 'GET', headers: { authorization: `Bearer ${key}` } };
  const res = responseCapture();
  await recoverHandler(req, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.view_key, '11'.repeat(32));
  assert.equal(res.body.payments[0].token_contract, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(res.body.payments[0].decimals, 6);
});

test('recovery data is not returned without the merchant bearer key', async () => {
  const res = responseCapture();
  await recoverHandler({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 401);
  assert.equal(res.body.error, 'invalid api key');
});
