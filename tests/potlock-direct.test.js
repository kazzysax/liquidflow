const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISABLE_VERSE_ANALYTICS = '1';

const store = require('../api/_lib/store');
const chain = require('../api/_lib/chain');
const privy = require('../api/_lib/privy');

chain.currentBlock = async () => 123456n;
chain.confirmedBalance = async () => 0n;
privy.provisionMerchant = async () => ({
  userId: 'did:privy:potlock-owner',
  walletId: 'wallet_potlock_primary',
  walletAddress: '0x4444444444444444444444444444444444444444',
  paymentWallets: Array.from({ length: 10 }, (_, index) => ({ walletId: 'wallet_potlock_' + (index + 1), walletAddress: '0x' + String(index + 20).padStart(40, '0'), slot: index + 1 })),
});

const fundraiserHandler = require('../api/fundraisers');
const donationHandler = require('../api/fundraisers/[id]');

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

test('Potlock rotates donations across creator payment wallets', async () => {
  const created = responseCapture();
  await fundraiserHandler({
    method: 'POST',
    headers: {},
    body: {
      title: 'Direct Potlock',
      description: 'Mainnet campaign',
      email: 'creator@example.com',
      goal: 100,
      asset: 'USDC',
      chain: 'eip155:8453',
    },
  }, created);

  assert.equal(created.code, 201);
  assert.equal(created.body.primary_wallet, '0x4444444444444444444444444444444444444444');
  assert.match(created.body.api_key, /^lf_live_/);
  assert.equal('spend_key' in created.body, false);
  assert.equal('recovery_token' in created.body, false);

  const donation = responseCapture();
  await donationHandler({
    method: 'POST',
    query: { id: created.body.id },
    headers: {},
    body: { amount: '1000000' },
  }, donation);

  assert.equal(donation.code, 201);
  assert.equal(donation.body.deposit_address, '0x0000000000000000000000000000000000000020');
  assert.equal(donation.body.delivery_mode, 'wallet_pool');

  const payment = await store.get('payment:' + donation.body.payment_id);
  assert.equal(payment.mode, 'wallet_pool');
  assert.equal(payment.privyWalletId, 'wallet_potlock_1');
  assert.equal(payment.baselineBalance, '0');

  const duplicate = responseCapture();
  await donationHandler({
    method: 'POST',
    query: { id: created.body.id },
    headers: {},
    body: { amount: '1000000' },
  }, duplicate);
  assert.equal(duplicate.code, 201);
  assert.equal(duplicate.body.deposit_address, '0x0000000000000000000000000000000000000021');
});