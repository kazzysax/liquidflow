// /api/fundraisers/:id
//   GET  — fundraiser details + real computed totals
//   POST — create a donation request using the rotating campaign wallet pool
const crypto = require('crypto');
const store  = require('../_lib/store');
const chainEngine = require('../_lib/chain');
const { checkAndConfirm, ACTIVE_PAYMENT_STATUSES, assetConfig, isValidBaseAmount } = chainEngine;

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
    loaded.filter(p => ACTIVE_PAYMENT_STATUSES.has(p.status)).map(p => checkAndConfirm(p))
  );
  let raisedWei = 0n, count = 0, recent = [];
  for (const p of loaded) {
    if (p && p.status === 'confirmed') {
      raisedWei += BigInt(p.amount || '0');
      count++;
      const cfg = assetConfig(p.chain, p.asset);
      recent.push({ amount: Number(p.amount) / Math.pow(10, cfg ? cfg.decimals : 18), at: p.confirmedAt });
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
    const cfg = assetConfig(f.chain, f.asset);
    const dp = cfg ? cfg.decimals : 18;
    const raised = Number(t.raisedWei) / Math.pow(10, dp);
    return res.status(200).json({
      id: f.id, slug: f.slug, title: f.title, description: f.description,
      goal: f.goal, asset: f.asset, chain: f.chain,
      decimals: dp, symbol: cfg ? cfg.symbol : f.asset,
      token_contract: cfg ? cfg.contract : null,
      raised: Number(raised.toFixed(6)),
      raised_base: String(t.raisedWei),
      donation_count: t.count,
      pct: f.goal > 0 ? Math.min(100, Math.round((raised / f.goal) * 100)) : 0,
      recent: t.recent,
      delivery: 'rotating_pool_then_primary',
      created_at: f.createdAt,
    });
  }

  // ---- DONATE ----
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { amount, label = '' } = req.body || {};
  if (!assetConfig(f.chain, f.asset)) return res.status(409).json({ error: 'this legacy campaign no longer accepts donations; create a mainnet campaign' });
  if (!amount) return res.status(400).json({ error: 'amount is required' });
  // Reject "0", "-1", decimals, hex, scientific notation — otherwise a fake donation
  // confirms against `bal >= 0` and inflates the fundraiser's raised total / count.
  if (!isValidBaseAmount(amount)) {
    return res.status(400).json({ error: 'amount must be a positive integer in base units' });
  }

  const pool = Array.isArray(f.paymentWallets) ? f.paymentWallets : [];
  if (pool.length !== 10 || !/^0x[0-9a-fA-F]{40}$/.test(String(f.primaryWallet || ''))) {
    return res.status(409).json({ error: 'this campaign predates the 10-wallet pool; create a new campaign' });
  }

  // A donation request has no timer, so reserve one payment wallet until that
  // request confirms. This permits up to ten simultaneous open requests.
  const existingIds = await store.smembers('fundraiser:' + id + ':payments');
  const activeAddresses = new Set();
  for (const existingId of existingIds) {
    const existing = await store.get('payment:' + existingId);
    if (existing && ACTIVE_PAYMENT_STATUSES.has(existing.status)) {
      activeAddresses.add(String(existing.depositAddress).toLowerCase());
    }
  }
  const start = Number(f.paymentWalletCursor || 0) % pool.length;
  let selectedWallet = null;
  let selectedIndex = -1;
  for (let offset = 0; offset < pool.length; offset += 1) {
    const index = (start + offset) % pool.length;
    if (!activeAddresses.has(String(pool[index].walletAddress).toLowerCase())) {
      selectedWallet = pool[index]; selectedIndex = index; break;
    }
  }
  if (!selectedWallet) {
    return res.status(409).json({ error: 'all 10 campaign payment wallets have open donation requests' });
  }

  const paymentId = 'don_' + crypto.randomBytes(8).toString('hex');
  const depositAddress = selectedWallet.walletAddress;
  f.paymentWalletCursor = (selectedIndex + 1) % pool.length;
  await store.set('fundraiser:' + id, f);
  let baselineBalance, startBlock;
  try {
    baselineBalance = (await chainEngine.confirmedBalance(f.chain, depositAddress, f.asset)).toString();
    startBlock = (await chainEngine.currentBlock(f.chain)).toString();
  } catch {
    return res.status(503).json({ error: 'could not anchor this donation to the chain; please retry' });
  }

  const payment = {
    id: paymentId,
    fundraiserId: id,
    apiKey: f.apiKey || null,
    amount: String(amount),   // wei
    asset: f.asset,
    chain: f.chain,
    label,
    depositAddress,
    privyWalletId: selectedWallet.walletId,
    paymentWalletSlot: selectedWallet.slot,
    walletProvider: 'PRIVY_POOL',
    baselineBalance,
    mode: 'wallet_pool',
    status: 'awaiting_payment',
    createdAt: Date.now(),
    expiresAt: null, // fundraiser donation addresses intentionally do not expire
    startBlock,
  };

  await store.set(`payment:${paymentId}`, payment);
  await store.sadd('payments:pending', paymentId);
  await store.sadd(`fundraiser:${id}:payments`, paymentId);
  if (f.apiKey) await store.sadd('merchant:' + f.apiKey + ':payments', paymentId);

  return res.status(201).json({
    payment_id: paymentId,
    deposit_address: depositAddress,
    amount: payment.amount,
    asset: f.asset,
    chain: f.chain,
    status: 'awaiting_payment',
    delivery_mode: 'wallet_pool',
    expires_at: null,
  });
};
