// /api/merchants
//   POST — create a merchant + API key from the onboarding wizard
//   GET  — return the authenticated merchant's profile (for the dashboard)
const crypto = require('crypto');
const store  = require('../_lib/store');
const { generateKeypair } = require('../_lib/crypto');
const { isPublicHttpUrl } = require('../_lib/webhook');
const { trackVerseEvent } = require('../_lib/verse-analytics');
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
      payout:      m.payout || null,
      webhook_url: m.webhookUrl || null,
      webhook_secret: m.webhookSecret,
      status:      'active',
      created_at:  m.createdAt,
    };
    return res.status(200).json(out);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const {
    name, chains, settle, unify, dex, mode, payout, webhook,
  } = req.body || {};

  // --- Gating: no silent defaults for essentials. Reject incomplete/unsafe signups. ---
  const isUrl = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(payout || ''))) {
    return res.status(400).json({ error: 'a valid EVM sweep / payout wallet is required' });
  }

  const normalizedDex = unify ? String(dex || '').trim() : null;
  if (unify && normalizedDex !== 'LIQUIDFLOW_APPROVED_ROUTES') {
    return res.status(400).json({ error: 'liquidity unification requires the LiquidFlow approved route provider' });
  }

  const merchantId    = 'm_' + crypto.randomBytes(8).toString('hex');
  const apiKeyVal     = 'lf_live_' + crypto.randomBytes(16).toString('hex');
  const webhookSecret = 'whsec_' + crypto.randomBytes(16).toString('hex');

  const merchant = {
    id: merchantId,
    name: String(name).trim(),
    apiKey: apiKeyVal,
    webhookUrl: webhook,
    webhookSecret,
    mode,
    chains,
    settle: String(settle).toUpperCase(),
    unify,
    dex: normalizedDex,
    payout: String(payout),
    status: 'active',
    activatedAt: Date.now(),
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

  await store.set(`merchant:${apiKeyVal}`, merchant);
  await trackVerseEvent('Merchant Created', { mode, settle, chains: chains.join(',') });

  const resp = {
    merchant_id:    merchantId,
    api_key:        apiKeyVal,
    webhook_secret: webhookSecret,
    mode,
    status: 'active',
  };
  if (spendKey) {
    resp.spend_key          = spendKey;     // Ethereum / Polygon / Base
    resp.view_key           = viewKey;
    resp.spend_key_note = 'Save spend_key offline now — it is never stored by LiquidFlow and cannot be recovered. view_key is also required by the offline sweep tool and remains available through the authenticated recovery endpoint.';
  }

  return res.status(201).json(resp);
};
