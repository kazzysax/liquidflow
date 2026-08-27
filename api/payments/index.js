// /api/payments
//   POST — create a payment, return the deposit address
//   GET  — list all payments for the authenticated merchant (newest first)
const crypto = require('crypto');
const store  = require('../_lib/store');
const { trackVerseEvent } = require('../_lib/verse-analytics');
const chainEngine = require('../_lib/chain');
const { CHECKOUT_TTL_MS, ACTIVE_PAYMENT_STATUSES, checkAndConfirm, assetConfig, assetsForChain, assetOk, isValidBaseAmount, chainSupported, chainDisabledReason } = chainEngine;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function apiKey(req) {
  return (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
}

function publicView(p) {
  const cfg = assetConfig(p.chain, p.asset);
  const remainingMs = Math.max(0, Number(p.expiresAt || 0) - Date.now());
  return {
    payment_id:      p.id,
    checkout_url:    `/pay.html?id=${p.id}`,
    deposit_address: p.depositAddress,
    amount:          p.amount,
    asset:           p.asset,
    chain:           p.chain,
    decimals:        cfg ? cfg.decimals : null,
    symbol:          cfg ? cfg.symbol : p.asset,
    token_contract:  cfg ? cfg.contract : null,
    status:          p.status,
    label:           p.label || null,
    delivery_mode:   'direct',
    created_at:      p.createdAt,
    confirmed_at:    p.confirmedAt || null,
    received_amount: p.receivedAmount || '0',
    payer_address:   p.payerAddress || null,
    transaction_hashes: p.transactionHashes || [],
    refund:          p.refund || null,
    expires_at:      p.expiresAt,
    remaining_seconds: Math.ceil(remainingMs / 1000),
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
      items.filter(p => ACTIVE_PAYMENT_STATUSES.has(p.status)).map(p => checkAndConfirm(p))
    );
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const now = Date.now();
    const confirmed = items.filter(p => p.status === 'confirmed');
    const pending   = items.filter(p => ACTIVE_PAYMENT_STATUSES.has(p.status) && now < p.expiresAt);
    // Sum each confirmed payment in its own chain's native units (human-readable).
    const volume = confirmed.reduce((s, p) => {
      const cfg = assetConfig(p.chain, p.asset);
      return s + (cfg ? Number(BigInt(p.amount)) / (10 ** cfg.decimals) : 0);
    }, 0);

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

  // Subscription gating was removed. Transparently release legacy merchant keys.
  if (merchant.status === 'pending_activation') {
    merchant.status = 'active';
    merchant.activatedAt = merchant.activatedAt || Date.now();
    delete merchant.onboardingPaymentId;
    await store.set(`merchant:${key}`, merchant);
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
  // Only issuer-verified ERC-20 contracts in the server-side mainnet allowlist qualify.
  if (!assetOk(chain, asset)) {
    return res.status(400).json({ error: `${asset} is not supported on ${chain}`, supported: assetsForChain(chain).map(a => a.symbol) });
  }

  const paymentId = 'pay_' + crypto.randomBytes(8).toString('hex');
  const expiresAt = Date.now() + CHECKOUT_TTL_MS;

  // Every checkout pays the merchant's single primary wallet directly.
  // Confirmation keys off a confirmed balance increase because the address is reused.
  const privyMerchant = Boolean(merchant.privyUserId && merchant.privyWalletAddress);
  const depositAddress = privyMerchant ? merchant.privyWalletAddress : merchant.payout;
  const privyWalletId = privyMerchant ? merchant.privyWalletId : null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(depositAddress || ''))) {
    return res.status(400).json({ error: 'merchant has no valid primary wallet configured' });
  }

  // A shared wallet cannot safely distinguish concurrent unpaid invoices for the
  // same token and network. Reject that case instead of double-confirming one transfer.
  const existingIds = await store.smembers('merchant:' + key + ':payments');
  for (const existingId of existingIds) {
    const existing = await store.get('payment:' + existingId);
    const existingCfg = existing && assetConfig(existing.chain, existing.asset);
    const requestedCfg = assetConfig(chain, asset);
    if (existing && ACTIVE_PAYMENT_STATUSES.has(existing.status) && existing.chain === chain &&
        existingCfg && requestedCfg && existingCfg.contract.toLowerCase() === requestedCfg.contract.toLowerCase() &&
        Date.now() < existing.expiresAt) {
      return res.status(409).json({ error: 'an unpaid invoice already exists for this asset and network' });
    }
  }

  let baselineBalance;
  try {
    baselineBalance = (await chainEngine.confirmedBalance(chain, depositAddress, asset)).toString();
  } catch (e) {
    return res.status(503).json({ error: 'could not read chain state to baseline this payment; please retry' });
  }
  let startBlock;
  try {
    startBlock = (await chainEngine.currentBlock(chain)).toString();
  } catch (e) {
    return res.status(503).json({ error: 'could not anchor this invoice to the chain; please retry' });
  }

  const payment = {
    id: paymentId,
    merchantId: merchant.id,
    apiKey: key,
    amount: String(amount),
    asset: assetConfig(chain, asset).symbol,
    chain,
    label: label || '',
    depositAddress,
    privyWalletId,
    walletProvider: privyMerchant ? 'PRIVY' : 'LEGACY',
    baselineBalance,
    mode: 'direct',
    status: 'awaiting_payment',
    createdAt: Date.now(),
    expiresAt,
    startBlock,
  };

  await store.set(`payment:${paymentId}`, payment);
  await store.sadd('payments:pending', paymentId);
  await store.sadd(`merchant:${key}:payments`, paymentId);

  await trackVerseEvent('Payment Created', {
    asset: payment.asset,
    chain: payment.chain,
    delivery_mode: 'direct',
  });

  return res.status(201).json(publicView(payment));
};
