const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTransfers } = require('../api/_lib/chain');

const payer = '0x1111111111111111111111111111111111111111';
const payment = { amount: '100', expiresAt: 10_000 };
const tx = (id, amount, from = payer) => ({ id, amount, from, txHash: `0x${id}` });

test('exact transfer confirms and duplicate logs are ignored', () => {
  const result = classifyTransfers(payment, [tx('a', '100'), tx('a', '100')], 5_000);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.received, 100n);
});

test('underpayment waits for a top-up before expiry', () => {
  const result = classifyTransfers(payment, [tx('a', '40')], 5_000);
  assert.equal(result.status, 'awaiting_topup');
});

test('overpayment records only the excess for refund', () => {
  const result = classifyTransfers(payment, [tx('a', '130')], 5_000);
  assert.equal(result.status, 'refund_pending');
  assert.equal(result.refund, 30n);
});

test('expired underpayment refunds the full amount after finality grace', () => {
  const result = classifyTransfers(payment, [tx('a', '40')], 700_001);
  assert.equal(result.status, 'refund_pending');
  assert.equal(result.refund, 40n);
});

test('payments from multiple senders require manual review', () => {
  const result = classifyTransfers(payment, [tx('a', '50'), tx('b', '50', '0x2222222222222222222222222222222222222222')], 5_000);
  assert.equal(result.status, 'manual_review');
});
