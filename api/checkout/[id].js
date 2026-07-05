// GET /api/checkout/:id — PUBLIC payer-safe view of a payment, for the hosted
// checkout page (pay.html). The payment_id is the capability the payer holds (like a
// Stripe checkout-session id): it exposes only what a payer needs to pay — never the
// merchant's API key, webhook secret, or stealth ephemeral key (R).
// Runs an on-demand on-chain check so a real deposit flips to confirmed within seconds.
const store = require('../_lib/store');
const { checkAndConfirm, decimals, symbol } = require('../_lib/chain');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const { id } = req.query;
  const payment = await store.get(`payment:${id}`);
  if (!payment) return res.status(404).json({ error: 'not found' });
  // Onboarding invoices are internal; not a public checkout.
  if (payment.onboarding) return res.status(404).json({ error: 'not found' });

  await checkAndConfirm(payment); // confirm now if the deposit has landed

  let merchantName = 'Merchant';
  if (payment.apiKey) {
    const m = await store.get(`merchant:${payment.apiKey}`);
    if (m && m.name) merchantName = m.name;
  }

  return res.status(200).json({
    payment_id:      payment.id,
    merchant_name:   merchantName,
    label:           payment.label || null,
    amount:          payment.amount,
    asset:           payment.asset,
    chain:           payment.chain,
    decimals:        decimals(payment.chain),
    symbol:          symbol(payment.chain),
    deposit_address: payment.depositAddress,
    status:          payment.status,
    created_at:      payment.createdAt,
    confirmed_at:    payment.confirmedAt || null,
    expires_at:      payment.expiresAt,
  });
};
