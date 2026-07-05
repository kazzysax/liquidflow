// POST /api/simulate/:id — INTERNAL TEST HELPER ONLY.
//
// Payment confirmation is done EXCLUSIVELY by the watcher model (real on-chain check
// in _lib/chain.checkAndConfirm + cron/watch.js). Merchants can never confirm a payment.
// This endpoint exists only to exercise webhook handlers when you can't send a real
// testnet deposit. It is:
//   - hard-disabled in production,
//   - disabled unless ALLOW_TEST_CONFIRM=1 is explicitly set,
//   - gated behind a server-side TEST_CONFIRM_SECRET (never a merchant API key).
const store   = require('../_lib/store');
const { confirmPayment } = require('../_lib/confirm');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // Never expose fake confirmation in production or unless explicitly enabled.
  if (process.env.VERCEL_ENV === 'production' || process.env.ALLOW_TEST_CONFIRM !== '1') {
    return res.status(404).json({ error: 'not found' });
  }
  const secret = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.TEST_CONFIRM_SECRET || secret !== process.env.TEST_CONFIRM_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { id } = req.query;
  const payment = await store.get(`payment:${id}`);
  if (!payment) return res.status(404).json({ error: 'payment not found' });
  if (payment.status !== 'awaiting_payment') {
    return res.status(400).json({ error: `payment already ${payment.status}` });
  }

  const webhookSent = await confirmPayment(payment, 12);

  return res.status(200).json({ ok: true, webhook_sent: webhookSent });
};
