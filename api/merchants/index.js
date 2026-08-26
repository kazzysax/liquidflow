// /api/merchants
//   POST — create a merchant + API key from the onboarding wizard
//   GET  — return the authenticated merchant's profile (for the dashboard)
const crypto = require('crypto');
const store  = require('../_lib/store');
const { isPublicHttpUrl } = require('../_lib/webhook');
const { trackVerseEvent } = require('../_lib/verse-analytics');
const privy = require('../_lib/privy');
const { buildPortfolio } = require('../_lib/portfolio');
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
    if (req.query && req.query.view === 'portfolio') {
      return res.status(200).json(await buildPortfolio(m, key));
    }
    // Subscription gating was removed. Release legacy merchants that were waiting
    // for the old onboarding invoice as soon as they authenticate.
    if (m.status === 'pending_activation') {
      m.status = 'active';
      m.activatedAt = m.activatedAt || Date.now();
      delete m.onboardingPaymentId;
      await store.set(`merchant:${key}`, m);
    }
    const out = {
      merchant_id: m.id,
      name:        m.name || 'Merchant',
      mode:        m.mode,
      chains:      m.chains || [],
      settle:      m.settle || 'AS_RECEIVED',
      unify:       m.unify === true,
      dex:         m.dex || null,
      payout:      m.privyUserId ? null : (m.payout || null),
      email:       m.email || null,
      privy_user_id: m.privyUserId || null,
      settlement:  privy.settlementView(m),
      webhook_url: m.webhookUrl || null,
      webhook_secret: m.webhookSecret,
      status:      'active',
      created_at:  m.createdAt,
    };
    return res.status(200).json(out);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const {
    name, email, chains, settle, unify, dex, mode, webhook,
  } = req.body || {};

  // --- Gating: no silent defaults for essentials. Reject incomplete/unsafe signups. ---
  const isUrl = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'a valid merchant email is required for the merchant-owned Privy wallet' });
  }
  if (!isUrl(webhook)) {
    return res.status(400).json({ error: 'a valid webhook URL (https) is required so you receive payment confirmations' });
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
  if (!['AS_RECEIVED', 'USDC', 'VERSE', 'FXVERSE'].includes(String(settle || '').toUpperCase())) {
    return res.status(400).json({ error: 'settle must be AS_RECEIVED, USDC, VERSE or fxVERSE' });
  }
  if (typeof unify !== 'boolean') {
    return res.status(400).json({ error: 'unify must be explicitly true or false' });
  }
  if (String(settle).toUpperCase() === 'AS_RECEIVED' && unify === true) {
    return res.status(400).json({ error: 'AS_RECEIVED settlement cannot enable liquidity unification' });
  }
  const normalizedDex = unify ? String(dex || '').trim() : null;
  if (unify && normalizedDex !== 'LIQUIDFLOW_APPROVED_ROUTES') {
    return res.status(400).json({ error: 'liquidity unification requires the LiquidFlow approved route provider' });
  }

  const merchantId    = 'm_' + crypto.randomBytes(8).toString('hex');
  const apiKeyVal     = 'lf_live_' + crypto.randomBytes(16).toString('hex');
  const webhookSecret = 'whsec_' + crypto.randomBytes(16).toString('hex');

  let privyMerchant = null;
  try {
    privyMerchant = await privy.provisionMerchant(normalizedEmail, merchantId);
  } catch (error) {
    console.error('Privy merchant provisioning failed:', error && error.message);
    return res.status(502).json({ error: 'merchant wallet provisioning failed; no gateway was created' });
  }
  if (!privyMerchant) {
    return res.status(503).json({ error: 'merchant wallet service is unavailable; no gateway was created' });
  }

  const merchant = {
    id: merchantId,
    name: String(name).trim(),
    email: normalizedEmail,
    apiKey: apiKeyVal,
    webhookUrl: webhook,
    webhookSecret,
    mode,
    chains,
    settle: String(settle).toUpperCase(),
    unify,
    dex: normalizedDex,
    payout: null,
    settlementProvider: 'PRIVY_USER_OWNED',
    privyUserId: privyMerchant && privyMerchant.userId,
    privyWalletId: privyMerchant && privyMerchant.walletId,
    privyWalletAddress: privyMerchant && privyMerchant.walletAddress,
    status: 'active',
    activatedAt: Date.now(),
    createdAt: Date.now(),
  };

  await store.set(`merchant:${apiKeyVal}`, merchant);
  await trackVerseEvent('Merchant Created', { mode, settle, chains: chains.join(',') });

  const resp = {
    merchant_id:    merchantId,
    api_key:        apiKeyVal,
    webhook_secret: webhookSecret,
    mode,
    status: 'active',
    settlement: privy.settlementView(merchant),
  };

  return res.status(201).json(resp);
};
