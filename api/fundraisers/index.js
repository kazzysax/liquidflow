// /api/fundraisers
//   POST — create a fundraiser (Potlock campaign) with its own stealth keypair
//   GET  — list all fundraisers with real (computed) totals
const crypto = require('crypto');
const store  = require('../_lib/store');
const { generateKeypair } = require('../_lib/crypto');
const ed = require('../_lib/stealth_ed25519');
const { decimals, symbol, assetForChain, assetOk, chainSupported, chainDisabledReason } = require('../_lib/chain');

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
  const raised = Number(t.raisedWei) / Math.pow(10, decimals(f.chain));
  return {
    id:            f.id,
    slug:          f.slug,
    title:         f.title,
    description:   f.description,
    goal:          f.goal,                 // in the chain's native units
    asset:         f.asset,
    chain:         f.chain,
    decimals:      decimals(f.chain),
    symbol:        symbol(f.chain),
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

  const { title, description = '', goal, asset, chain = 'eip155:84532' } = req.body || {};
  if (!title || !goal) return res.status(400).json({ error: 'title and goal are required' });
  const goalNum = Number(goal);
  if (!Number.isFinite(goalNum) || goalNum <= 0) {
    return res.status(400).json({ error: 'goal must be a positive number' });
  }
  if (!chainSupported(chain)) return res.status(400).json({ error: chainDisabledReason(chain) });
  // Each chain raises in exactly one asset (native token; Arc = USDC). Default to it,
  // and reject any explicit mismatch.
  const useAsset = asset || symbol(chain);
  if (!assetOk(chain, useAsset)) {
    return res.status(400).json({ error: `${chain} settles in ${assetForChain(chain)}, not ${useAsset}` });
  }

  const id = 'fr_' + crypto.randomBytes(6).toString('hex');
  const kp  = generateKeypair();     // secp256k1 — EVM campaigns
  const ekp = ed.generateKeypair();  // ed25519 — Solana / Sui campaigns

  const fundraiser = {
    id,
    slug: slugify(title) + '-' + id.slice(3, 7),
    title,
    description,
    goal: goalNum,
    asset: useAsset,
    chain,
    mode: 'stealth',
    P_spend: kp.P_spend, P_view: kp.P_view, k_view: kp.k_view,
    P_spend_ed: ekp.P_spend, P_view_ed: ekp.P_view, k_view_ed: ekp.k_view,
    createdAt: Date.now(),
  };

  await store.set(`fundraiser:${id}`, fundraiser);
  await store.sadd('fundraisers:all', id);

  const isEd = (chain === 'solana' || chain === 'sui');
  return res.status(201).json({
    id,
    slug: fundraiser.slug,
    title,
    goal: fundraiser.goal,
    chain,
    url: `/potlock-private.html?id=${id}`,
    spend_key: isEd ? ekp.k_spend : kp.k_spend,
    spend_key_note: 'Save this — it is the only key that can sweep donations to your wallet. Never shown again.',
  });
};
