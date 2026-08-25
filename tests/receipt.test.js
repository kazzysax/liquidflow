const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const pair = crypto.generateKeyPairSync('ed25519');
process.env.RECEIPT_SIGNING_PRIVATE_KEY_B64 = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const receipts = require('../api/_lib/receipt');

const payment = {
  id: 'pay_0123456789abcdef', status: 'confirmed', chain: 'eip155:1', asset: 'VERSE',
  amount: '1000000000000000000', depositAddress: '0x1111111111111111111111111111111111111111',
  payerAddress: '0x2222222222222222222222222222222222222222', confirmedAt: 1787600000000,
  confirmations: 24, transactionHashes: ['0x' + 'ab'.repeat(32)],
};

test('confirmed payment receives a valid deterministic Ed25519 receipt', () => {
  const a = receipts.issue(payment, 'Plate & Pulse');
  const b = receipts.issue(payment, 'Plate & Pulse');
  assert.equal(a.receipt.receipt_id, b.receipt.receipt_id);
  assert.equal(a.signature_b64, b.signature_b64);
  assert.equal(receipts.verify(a), true);
});

test('changing any signed receipt field invalidates it', () => {
  const bundle = receipts.issue(payment, 'Plate & Pulse');
  bundle.receipt.amount_base_units = '9000000000000000000';
  assert.equal(receipts.verify(bundle), false);
});

test('receipt refuses an unconfirmed payment or missing transaction proof', () => {
  assert.throws(() => receipts.issue({ ...payment, status: 'awaiting_payment' }, 'Merchant'));
  assert.throws(() => receipts.issue({ ...payment, transactionHashes: [] }, 'Merchant'));
});
