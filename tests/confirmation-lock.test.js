const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_lib/store');
const webhook = require('../api/_lib/webhook');
const { confirmPayment } = require('../api/_lib/confirm');

test('only one concurrent watcher acquires the payment confirmation transition', async () => {
  const id = 'pay_concurrency_audit';
  const payment = {
    id,
    status: 'awaiting_payment',
    amount: '1',
    asset: 'USDC',
    chain: 'eip155:8453',
    apiKey: 'lf_live_concurrency_audit',
  };
  await store.set('merchant:lf_live_concurrency_audit', {
    id: 'm_concurrency_audit',
    webhookUrl: 'https://example.com/hook',
    webhookSecret: 'whsec_audit',
  });
  const originalSend = webhook.send;
  let deliveries = 0;
  webhook.send = async () => { deliveries += 1; };
  await store.set(`payment:${id}`, payment);
  const a = { ...payment };
  const b = { ...payment };
  try {
    await Promise.all([confirmPayment(a, 30), confirmPayment(b, 30)]);
  } finally {
    webhook.send = originalSend;
  }
  const stored = await store.get(`payment:${id}`);
  assert.equal(stored.status, 'confirmed');
  assert.ok(Number.isFinite(stored.confirmedAt));
  assert.equal(deliveries, 1);
});

test('setIfAbsent permits only one lock owner', async () => {
  const key = 'lock:audit:unique';
  const results = await Promise.all([
    store.setIfAbsent(key, 'a', 30),
    store.setIfAbsent(key, 'b', 30),
    store.setIfAbsent(key, 'c', 30),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});
