// /api/payments
//   POST — create a payment, return the deposit address
//   GET  — list all payments for the authenticated merchant (newest first)
const crypto = require('crypto');
const store  = require('../_lib/store');
const { deriveDepositAddress } = require('../_lib/crypto');
const ed = require('../_lib/stealth_ed25519');
const { checkAndConfirm, decimals, symbol, toHuman, assetForChain, assetOk, isValidBaseAmount, confirmedBalance, chainSupported, chainDisabledReason } = require('../_lib/chain');

// Derive a stealth deposit address for the given chain from a recipient's meta-keys.
function deriveForChain(chain, ent, paymentId) {
  if (chain === 'solana') return ed.solanaAddress(ent.P_spend_ed, ent.P_view_ed);
  if (chain === 'sui')    return ed.suiAddress(ent.P_spend_ed, ent.P_view_ed);
  return deriveDepositAddress(ent.P_spend, ent.P_view, paymentId); // eip155 (secp256k1)
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function apiKey(req) {
  return (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
}

function publicView(p) {
  return {
    payment_id:      p.id,
    checkout_url:    `/pay.html?id=${p.id}`,
    deposit_address: p.depositAddress,
    amount:          p.amount,
    asset:           p.asset,
    chain:           p.chain,
    decimals:        decimals(p.chain),
    symbol:          symbol(p.chain),
    status:          p.status,
    label:           p.label || null,
    privacy_mode:    p.mode,
    created_at:      p.createdAt,
    confirmed_at:    p.confirmedAt || null,
    expires_at:      p.expiresAt,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = apiKey(req);
  const merchant = await store.get(`merchant:${key}`);
  if (!merchant) return res.status(401).json({ error: 'invalid api key' });

  // ---- LIST ----
  if (req.method === 'GET') {
    const ids = await store.smembers(`merchant:${key}:payments`);
    const items = [];
    for (const id of ids) {
      const p = await store.get(`payment:${id}`);
      if (p) items.push(p);
    }
    // On-demand: confirm any pending deposits that have landed on-chain.
    await Promise.allSettled(
      items.filter(p => p.status === 'awaiting_payment').map(p => checkAndConfirm(p))
    );
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const now = Date.now();
    const confirmed = items.filter(p => p.status === 'confirmed');
    const pending   = items.filter(p => p.status === 'awaiting_payment' && now < p.expiresAt);
    // Sum each confirmed payment in its own chain's native units (human-readable).
    const volume = confirmed.reduce((s, p) => s + toHuman(p.amount, p.chain), 0);

    return res.status(200).json({
      payments: items.map(publicView),
      stats: {
        total:     items.length,
        confirmed: confirmed.length,
        pending:   pending.length,
        volume:    volume.toFixed(6),
      },
    });
  }

  // ---- CREATE ----
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // Gated: the gateway must be activated (onboarding fee paid) before it can take payments.
  if ((merchant.status || 'active') === 'pending_activation') {
    return res.status(402).json({ error: 'gateway not activated — pay the onboarding fee to enable payments' });
  }

  const { amount, asset, chain, label } = req.body || {};
  if (chain && !chainSupported(chain)) {
    return res.status(400).json({ error: chainDisabledReason(chain) });
  }
  if (!amount || !asset || !chain) {
    return res.status(400).json({ error: 'amount, asset and chain are required' });
  }
  // Amount must be a positive base-unit integer (wei/lamports/USDC-6dp). Rejects
  // "0", "-1", decimals, hex and scientific notation before any of it can confirm.
  if (!isValidBaseAmount(amount)) {
    return res.status(400).json({ error: 'amount must be a positive integer in base units (wei/lamports/6-dp)' });
  }
  // Each chain settles in exactly one asset (its native token; Arc = USDC). Reject
  // any mismatch — e.g. USDC on Base — so nothing is confirmed against the wrong balance.
  if (!assetOk(chain, asset)) {
    return res.status(400).json({ error: `${chain} settles in ${assetForChain(chain)}, not ${asset}` });
  }
  // Solana/Sui use ed25519 stealth derivation, which only stealth-mode merchants have keys for.
  if ((chain === 'solana' || chain === 'sui') && merchant.mode !== 'stealth') {
    return res.status(400).json({ error: 'Solana and Sui require a stealth-mode merchant' });
  }

  const paymentId = 'pay_' + crypto.randomBytes(8).toString('hex');
  const expiresAt = Date.now() + 30 * 60 * 1000; // 30 min window

  let depositAddress, R = null, baselineBalance = null;
  if (merchant.mode === 'stealth') {
    const result = deriveForChain(chain, merchant, paymentId);
    depositAddress = result.depositAddress;
    R = result.R; // stored server-side only — never returned to payer
  } else {
    // Instant mode: funds go straight to the merchant's real payout address.
    // No synthetic fallback — a hashed pseudo-address would be unspendable (lost funds).
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(merchant.payout || ''))) {
      return res.status(400).json({ error: 'merchant has no valid payout address configured' });
    }
    depositAddress = merchant.payout;
    // The payout wallet is reused across payments and carries a standing balance,
    // so confirmation must key off a RISE in balance, not the absolute amount.
    // Capture the baseline now; checkAndConfirm confirms only when bal >= baseline+amount.
    // Read at the same confirmation depth the watcher uses so baseline and confirm
    // reads are consistent. Fail the request if we can't read it — an instant payment
    // with no baseline is unconfirmable, so we never create one (fail closed).
    try {
      baselineBalance = (await confirmedBalance(chain, depositAddress)).toString();
    } catch (e) {
      return res.status(503).json({ error: 'could not read chain state to baseline this payment; please retry' });
    }
  }

  const payment = {
    id: paymentId,
    merchantId: merchant.id,
    apiKey: key,
    amount: String(amount),
    asset,
    chain,
    label: label || '',
    depositAddress,
    R,
    baselineBalance, // instant mode only — null for stealth (fresh address)
    mode: merchant.mode,
    status: 'awaiting_payment',
    createdAt: Date.now(),
    expiresAt,
  };

  await store.set(`payment:${paymentId}`, payment);
  await store.sadd('payments:pending', paymentId);
  await store.sadd(`merchant:${key}:payments`, paymentId);

  return res.status(201).json(publicView(payment));
};
