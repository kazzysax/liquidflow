// /api/fundraisers/:id
//   GET  — fundraiser details + real computed totals
//   POST — make a (private, stealth) donation; returns a one-time deposit address
const crypto = require('crypto');
const store  = require('../_lib/store');
const { deriveDepositAddress } = require('../_lib/crypto');
const ed = require('../_lib/stealth_ed25519');
const { checkAndConfirm, decimals, symbol, isValidBaseAmount } = require('../_lib/chain');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function totals(id) {
  const ids = await store.smembers(`fundraiser:${id}:payments`);
  // On-demand: confirm any donations whose test-ETH deposit has landed.
  const loaded = [];
  for (const pid of ids) {
    const p = await store.get(`payment:${pid}`);
    if (p) loaded.push(p);
  }
  await Promise.allSettled(
    loaded.filter(p => p.status === 'awaiting_payment').map(p => checkAndConfirm(p))
  );
  let raisedWei = 0n, count = 0, recent = [];
  for (const p of loaded) {
    if (p && p.status === 'confirmed') {
      raisedWei += BigInt(p.amount || '0');
      count++;
      recent.push({ amount: Number(p.amount) / Math.pow(10, decimals(p.chain)), at: p.confirmedAt });
    }
  }
  recent.sort((a, b) => (b.at || 0) - (a.at || 0));
  return { raisedWei, count, recent: recent.slice(0, 12) };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  const f = await store.get(`fundraiser:${id}`);
  if (!f) return res.status(404).json({ error: 'fundraiser not found' });

  // ---- DETAILS ----
  if (req.method === 'GET') {
    const t = await totals(id);
    const raised = Number(t.raisedWei) / Math.pow(10, decimals(f.chain));
    return res.status(200).json({
      id: f.id, slug: f.slug, title: f.title, description: f.description,
      goal: f.goal, asset: f.asset, chain: f.chain,
      decimals: decimals(f.chain), symbol: symbol(f.chain),
      raised: Number(raised.toFixed(6)),
      raised_base: String(t.raisedWei),
      donation_count: t.count,
      pct: f.goal > 0 ? Math.min(100, Math.round((raised / f.goal) * 100)) : 0,
      recent: t.recent,
      created_at: f.createdAt,
    });
  }

  // ---- DONATE ----
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { amount, label = '' } = req.body || {};
  if (!amount) return res.status(400).json({ error: 'amount is required' });
  // Reject "0", "-1", decimals, hex, scientific notation — otherwise a fake donation
  // confirms against `bal >= 0` and inflates the fundraiser's raised total / count.
  if (!isValidBaseAmount(amount)) {
    return res.status(400).json({ error: 'amount must be a positive integer in base units' });
  }

  const paymentId = 'don_' + crypto.randomBytes(8).toString('hex');
  const { depositAddress, R } =
    f.chain === 'solana' ? ed.solanaAddress(f.P_spend_ed, f.P_view_ed)
    : f.chain === 'sui'  ? ed.suiAddress(f.P_spend_ed, f.P_view_ed)
    : deriveDepositAddress(f.P_spend, f.P_view, paymentId);

  const payment = {
    id: paymentId,
    fundraiserId: id,
    apiKey: null,             // public donation — no merchant
    amount: String(amount),   // wei
    asset: f.asset,
    chain: f.chain,
    label,
    depositAddress,
    R,
    mode: 'stealth',
    status: 'awaiting_payment',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000, // 1h window
  };

  await store.set(`payment:${paymentId}`, payment);
  await store.sadd('payments:pending', paymentId);
  await store.sadd(`fundraiser:${id}:payments`, paymentId);

  return res.status(201).json({
    payment_id: paymentId,
    deposit_address: depositAddress,
    amount: payment.amount,
    asset: f.asset,
    chain: f.chain,
    status: 'awaiting_payment',
    expires_at: payment.expiresAt,
  });
};
