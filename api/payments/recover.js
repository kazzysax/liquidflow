// GET /api/payments/recover — merchant-authenticated stealth recovery data.
//
// A stealth deposit is controlled by a one-time key the merchant derives OFFLINE
// from their own k_spend + k_view and the payment's ephemeral pubkey R. R is stored
// server-side (never published, never given to the payer), so without this endpoint
// a merchant literally cannot reconstruct the key and sweep their funds.
//
// This returns, for the authenticated merchant's CONFIRMED stealth payments, the
// (payment_id, R, deposit_address, chain, amount) tuples the offline sweep tool needs.
// It never returns any private key — k_spend lives only on the merchant's machine.
const store = require('../_lib/store');
const { symbol, decimals } = require('../_lib/chain');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function apiKey(req) {
  return (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const key = apiKey(req);
  const merchant = await store.get(`merchant:${key}`);
  if (!merchant) return res.status(401).json({ error: 'invalid api key' });
  if (merchant.mode !== 'stealth') {
    return res.status(400).json({ error: 'recovery data only applies to stealth-mode merchants' });
  }

  const ids = await store.smembers(`merchant:${key}:payments`);
  const recoverable = [];
  for (const id of ids) {
    const p = await store.get(`payment:${id}`);
    // Only confirmed stealth payments with an ephemeral key are sweepable.
    if (!p || p.mode !== 'stealth' || p.status !== 'confirmed' || !p.R) continue;
    recoverable.push({
      payment_id:      p.id,
      chain:           p.chain,
      curve:           (p.chain === 'solana' || p.chain === 'sui') ? 'ed25519' : 'secp256k1',
      R:               p.R,
      deposit_address: p.depositAddress,
      amount:          p.amount,
      symbol:          symbol(p.chain),
      decimals:        decimals(p.chain),
      confirmed_at:    p.confirmedAt || null,
    });
  }
  recoverable.sort((a, b) => (b.confirmed_at || 0) - (a.confirmed_at || 0));

  return res.status(200).json({
    count: recoverable.length,
    note:  'Feed each entry, with your own k_spend + k_view, to the offline sweep tool (tools/stealth-sweep-evm.js). Your keys never leave your machine.',
    payments: recoverable,
  });
};
