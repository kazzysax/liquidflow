// /api/merchants
//   POST — create a merchant + API key from the onboarding wizard
//   GET  — return the authenticated merchant's profile (for the dashboard)
const crypto = require('crypto');
const store  = require('../_lib/store');
const { generateKeypair } = require('../_lib/crypto');
const platform = require('../_lib/platform');
const { isPublicHttpUrl } = require('../_lib/webhook');
const { chainSupported } = require('../_lib/chain');
const MAINNET_CHAINS = new Set(['eip155:1', 'eip155:137', 'eip155:8453']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function apiKey(req) {
  return (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- PROFILE ----
  if (req.method === 'GET') {
    const key = apiKey(req);
    const m = await store.get(`merchant:${key}`);
    if (!m) return res.status(401).json({ error: 'invalid api key' });
    // Backward-compat: merchants created before gating had no status → treat as active.
    const status = m.status || 'active';
    const out = {
      merchant_id: m.id,
      name:        m.name || 'Merchant',
      mode:        m.mode,
      plan:        m.plan || null,
      chains:      m.chains || [],
      settle:      m.settle || 'USDC',
      payout:      m.payout || '',
      webhook_url: m.webhookUrl || '',
      webhook_secret: m.webhookSecret,
      status,
      created_at:  m.createdAt,
    };
    // While pending, surface the unpaid onboarding invoice so the UI can prompt payment.
    if (status !== 'active' && m.onboardingPaymentId) {
      const inv = await store.get(`payment:${m.onboardingPaymentId}`);
      if (inv) {
        out.onboarding = {
          payment_id:      inv.id,
          deposit_address: inv.depositAddress,
          amount:          inv.amount,
          asset:           inv.asset,
          chain:           inv.chain,
          decimals:        6,
          status:          inv.status,
          expires_at:      inv.expiresAt,
        };
      }
    }
    return res.status(200).json(out);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const {
    name     = '',
    chains   = [],
    settle   = 'USDC',
    unify    = true,
    dex      = 'NEAR Intents',
    mode     = 'instant',
    plan     = null,
    payout   = '',
    webhook  = '',
  } = req.body || {};

  // --- Gating: no silent defaults for essentials. Reject incomplete/unsafe signups. ---
  const isUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; } };
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!isUrl(webhook)) {
    return res.status(400).json({ error: 'a valid webhook URL (https) is required so you receive payment confirmations' });
  }
  if (process.env.VERCEL_ENV === 'production' && !/^https:/i.test(webhook)) {
    return res.status(400).json({ error: 'webhook URL must be https in production' });
  }
  // SSRF: we POST to this URL server-side, so it must resolve to a public host —
  // never localhost, cloud metadata (169.254.169.254), or a private/RFC1918 range.
  if (!isPublicHttpUrl(webhook)) {
    return res.status(400).json({ error: 'webhook URL must be a public address (no localhost/private/link-local hosts)' });
  }
  if (!Array.isArray(chains) || chains.some(c => !MAINNET_CHAINS.has(c))) {
    return res.status(400).json({ error: 'chains may contain only Ethereum, Polygon PoS and Base mainnet identifiers' });
  }
  if (chains.length === 0) {
    return res.status(400).json({ error: 'select at least one supported mainnet' });
  }
  if (mode !== 'instant' && mode !== 'stealth') {
    return res.status(400).json({ error: 'mode must be instant or stealth' });
  }
  if (!['USDC', 'VERSE', 'FXVERSE'].includes(String(settle || '').toUpperCase())) {
    return res.status(400).json({ error: 'settle must be USDC, VERSE or fxVERSE' });
  }
  // Instant (non-stealth) mode sends funds straight to `payout`, so it must be a real
  // EVM address. Stealth mode derives per-payment addresses and needs no payout here.
  if (mode !== 'stealth' && !/^0x[0-9a-fA-F]{40}$/.test(String(payout))) {
    return res.status(400).json({ error: 'instant mode requires a valid 0x payout address' });
  }

  const merchantId    = 'm_' + crypto.randomBytes(8).toString('hex');
  const apiKeyVal     = 'lf_live_' + crypto.randomBytes(16).toString('hex');
  const webhookSecret = 'whsec_' + crypto.randomBytes(16).toString('hex');

  const merchant = {
    id: merchantId,
    name,
    apiKey: apiKeyVal,
    webhookUrl: webhook,
    webhookSecret,
    mode,
    plan,
    chains,
    settle,
    unify,
    dex,
    payout,
    status: 'pending_activation', // becomes 'active' once the onboarding fee confirms
    createdAt: Date.now(),
  };

  let spendKey = null, viewKey = null;
  if (mode === 'stealth') {
    const kp = generateKeypair();              // secp256k1 — supported EVM mainnets
    merchant.P_spend = kp.P_spend;
    merchant.P_view  = kp.P_view;
    merchant.k_view  = kp.k_view;
    spendKey = kp.k_spend;
    viewKey = kp.k_view;
  }

  // Onboarding invoice: the merchant must pay the fee — through our own payment system —
  // before the gateway activates. A fresh Polygon address receives canonical USDC.
  const onboardingId = 'pay_' + crypto.randomBytes(8).toString('hex');
  const inv = await platform.createOnboardingInvoice(onboardingId);
  const onboardingPayment = {
    id: onboardingId,
    merchantId,
    apiKey: apiKeyVal,          // links the fee to the merchant it activates
    onboarding: true,
    amount: inv.amount,
    asset:  inv.asset,
    chain:  inv.chain,
    label: 'Liquid Flow gateway — 1 month',
    depositAddress: inv.depositAddress,
    R: inv.R,
    mode: 'stealth',
    status: 'awaiting_payment',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour to pay
  };
  merchant.onboardingPaymentId = onboardingId;

  await store.set(`merchant:${apiKeyVal}`, merchant);
  await store.set(`payment:${onboardingId}`, onboardingPayment);
  await store.sadd('payments:pending', onboardingId);

  const resp = {
    merchant_id:    merchantId,
    api_key:        apiKeyVal,      // issued now, but INERT until the fee is paid
    webhook_secret: webhookSecret,
    mode,
    plan,
    status: 'pending_activation',
    onboarding: {
      payment_id:      onboardingId,
      deposit_address: inv.depositAddress,
      amount:          inv.amount,
      asset:           inv.asset,
      chain:           inv.chain,
      decimals:        inv.decimals,
      expires_at:      onboardingPayment.expiresAt,
      note:            `Pay ${platform.FEE_USDC} ${inv.asset} on Polygon PoS to this address to activate your gateway. Confirmation is automatic (on-chain watcher).`,
    },
  };
  if (spendKey) {
    resp.spend_key          = spendKey;     // Ethereum / Polygon / Base
    resp.view_key           = viewKey;
    resp.spend_key_note = 'Save spend_key offline now — it is never stored by LiquidFlow and cannot be recovered. view_key is also required by the offline sweep tool and remains available through the authenticated recovery endpoint.';
  }

  return res.status(201).json(resp);
};
