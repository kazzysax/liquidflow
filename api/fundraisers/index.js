// /api/fundraisers
//   POST — create a fundraiser with a creator-owned primary Privy wallet
//   GET  — list all fundraisers with real (computed) totals
const crypto = require('crypto');
const store  = require('../_lib/store');
const privy = require('../_lib/privy');
const { assetConfig, assetsForChain, assetOk, chainSupported, chainDisabledReason } = require('../_lib/chain');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function slugify(s) {
  return String(s || 'fundraiser').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    || 'fundraiser';
}

// Compute real raised total (in ETH) + donation count from confirmed donations.
async function totals(id) {
  const ids = await store.smembers(`fundraiser:${id}:payments`);
  let raisedWei = 0n, count = 0;
  for (const pid of ids) {
    const p = await store.get(`payment:${pid}`);
    if (p && p.status === 'confirmed') { raisedWei += BigInt(p.amount || '0'); count++; }
  }
  return { raisedWei, count };
}

function publicView(f, t) {
  const cfg = assetConfig(f.chain, f.asset);
  const dp = cfg ? cfg.decimals : 18;
  const raised = Number(t.raisedWei) / Math.pow(10, dp);
  return {
    id:            f.id,
    slug:          f.slug,
    title:         f.title,
    description:   f.description,
    goal:          f.goal,                 // in the chain's native units
    asset:         f.asset,
    chain:         f.chain,
    decimals:      dp,
    symbol:        cfg ? cfg.symbol : f.asset,
    token_contract: cfg ? cfg.contract : null,
    raised:        Number(raised.toFixed(6)),
    raised_base:   String(t.raisedWei),
    donation_count: t.count,
    pct:           f.goal > 0 ? Math.min(100, Math.round((raised / f.goal) * 100)) : 0,
    created_at:    f.createdAt,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const ids = await store.smembers('fundraisers:all');
    const out = [];
    for (const id of ids) {
      const f = await store.get(`fundraiser:${id}`);
      if (f) out.push(publicView(f, await totals(id)));
    }
    out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return res.status(200).json({ fundraisers: out });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { title, description = '', goal, asset = 'VERSE', chain = 'eip155:1', email } = req.body || {};
  if (!title || !goal) return res.status(400).json({ error: 'title and goal are required' });
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return res.status(400).json({ error: 'a valid creator email is required' });
  if (String(title).trim().length > 100 || String(description).length > 1000) return res.status(400).json({ error: 'campaign text is too long' });
  const goalNum = Number(goal);
  if (!Number.isFinite(goalNum) || goalNum <= 0) {
    return res.status(400).json({ error: 'goal must be a positive number' });
  }
  if (!chainSupported(chain)) return res.status(400).json({ error: chainDisabledReason(chain) });
  // Only issuer-verified ERC-20 contracts in the server-side mainnet allowlist qualify.
  const useAsset = asset;
  if (!assetOk(chain, useAsset)) {
    return res.status(400).json({ error: `${useAsset} is not supported on ${chain}`, supported: assetsForChain(chain).map(a => a.symbol) });
  }

  const id = 'fr_' + crypto.randomBytes(6).toString('hex');
  const apiKey = 'lf_live_' + crypto.randomBytes(16).toString('hex');
  let wallet;
  try {
    wallet = await privy.provisionMerchant(normalizedEmail, id);
  } catch (error) {
    console.error('Potlock wallet provisioning failed:', error && error.message);
    return res.status(502).json({ error: 'campaign wallet provisioning failed; no campaign was created' });
  }
  if (!wallet) return res.status(503).json({ error: 'campaign wallet service is unavailable' });

  const fundraiser = {
    id,
    slug: slugify(title) + '-' + id.slice(3, 7),
    title: String(title).trim(),
    description: String(description).trim(),
    goal: goalNum,
    asset: assetConfig(chain, useAsset).symbol,
    chain,
    mode: 'direct',
    ownerEmail: normalizedEmail,
    apiKey,
    privyUserId: wallet.userId,
    privyWalletId: wallet.walletId,
    primaryWallet: wallet.walletAddress,
    createdAt: Date.now(),
  };

  const merchant = {
    id,
    name: String(title).trim(),
    email: normalizedEmail,
    apiKey,
    webhookUrl: null,
    webhookSecret: null,
    mode: 'direct',
    chains: [chain],
    settle: assetConfig(chain, useAsset).symbol.toUpperCase(),
    unify: false,
    dex: null,
    payout: null,
    settlementProvider: 'PRIVY_USER_OWNED',
    privyUserId: wallet.userId,
    privyWalletId: wallet.walletId,
    privyWalletAddress: wallet.walletAddress,
    status: 'active',
    activatedAt: Date.now(),
    createdAt: Date.now(),
  };
  await store.set(`fundraiser:${id}`, fundraiser);
  await store.sadd('fundraisers:all', id);
  await store.set('merchant:' + apiKey, merchant);

  return res.status(201).json({
    id,
    slug: fundraiser.slug,
    title: fundraiser.title,
    goal: fundraiser.goal,
    asset: fundraiser.asset,
    chain,
    url: '/potlock-private.html?id=' + id,
    api_key: apiKey,
    primary_wallet: wallet.walletAddress,
    dashboard_url: '/dashboard.html',
    custody: 'creator_owned_privy',
  });
};
