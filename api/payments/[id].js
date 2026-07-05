// /api/payments/:id
//   GET  — check payment status (on-demand on-chain check confirms real deposits fast).
//   POST — cancel the payment. A merchant may ONLY cancel a pending payment; they can
//          never confirm one. Confirmation is done exclusively by the watcher model.
//   - Merchant payments require the matching API key.
//   - Public fundraiser donations (no merchant) are readable by id (the id is the
//     capability token the donor holds).
const store = require('../_lib/store');
const { checkAndConfirm } = require('../_lib/chain');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function apiKey(req) {
  return (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const { id } = req.query;
  const payment = await store.get(`payment:${id}`);
  if (!payment) return res.status(404).json({ error: 'not found' });

  // Merchant-owned payments are private to that merchant.
  if (payment.apiKey && apiKey(req) !== payment.apiKey) {
    return res.status(404).json({ error: 'not found' });
  }

  // ---- CANCEL (merchant action; the only status change a merchant may make) ----
  if (req.method === 'POST') {
    if (!payment.apiKey) {
      return res.status(403).json({ error: 'this payment cannot be cancelled here' });
    }
    if (payment.status === 'confirmed') {
      return res.status(409).json({ error: 'payment already confirmed on-chain and cannot be cancelled' });
    }
    if (payment.status !== 'awaiting_payment') {
      return res.status(409).json({ error: `payment already ${payment.status}` });
    }
    payment.status = 'cancelled';
    payment.cancelledAt = Date.now();
    await store.set(`payment:${payment.id}`, payment);
    await store.srem('payments:pending', payment.id);
    return res.status(200).json({ payment_id: payment.id, status: payment.status });
  }

  await checkAndConfirm(payment); // confirm now if the deposit has landed

  return res.status(200).json({
    payment_id:      payment.id,
    status:          payment.status,
    deposit_address: payment.depositAddress,
    amount:          payment.amount,
    asset:           payment.asset,
    chain:           payment.chain,
    confirmed_at:    payment.confirmedAt || null,
    expires_at:      payment.expiresAt,
  });
};
