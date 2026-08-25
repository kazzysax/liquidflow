const store = require('./_lib/store');
const { checkAndConfirm } = require('./_lib/chain');
const receipts = require('./_lib/receipt');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function merchantNameFor(payment) {
  if (!payment.apiKey) return 'Merchant';
  const merchant = await store.get(`merchant:${payment.apiKey}`);
  return merchant && merchant.name ? merchant.name : 'Merchant';
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = String(req.query.action || '');

  if (action === 'public-key' && req.method === 'GET') {
    try {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).json(receipts.publicKeyInfo());
    } catch { return res.status(503).json({ error: 'receipt verifier is not configured' }); }
  }

  if (action === 'get' && req.method === 'GET') {
    const id = String(req.query.id || '');
    if (!/^pay_[a-f0-9]{16}$/.test(id)) return res.status(400).json({ error: 'invalid payment id' });
    const payment = await store.get(`payment:${id}`);
    if (!payment || payment.onboarding) return res.status(404).json({ error: 'not found' });
    await checkAndConfirm(payment);
    if (payment.status !== 'confirmed') return res.status(409).json({ error: 'receipt is available after payment confirmation', status: payment.status });
    try {
      const bundle = receipts.issue(payment, await merchantNameFor(payment));
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('Content-Disposition', `inline; filename="liquidflow-${id}-receipt.json"`);
      return res.status(200).json(bundle);
    } catch { return res.status(503).json({ error: 'signed receipt is temporarily unavailable' }); }
  }

  if (action === 'verify' && req.method === 'POST') {
    const bundle = req.body || {};
    if (!receipts.verify(bundle)) return res.status(200).json({ valid: false, signature_valid: false, record_matches: false });
    const id = String(bundle.receipt && bundle.receipt.payment_id || '');
    const payment = await store.get(`payment:${id}`);
    if (!payment || payment.status !== 'confirmed') return res.status(200).json({ valid: false, signature_valid: true, record_matches: false });
    let expected;
    try { expected = receipts.receiptFor(payment, await merchantNameFor(payment)); }
    catch { return res.status(200).json({ valid: false, signature_valid: true, record_matches: false }); }
    const recordMatches = receipts.canonical(expected).equals(receipts.canonical(bundle.receipt));
    return res.status(200).json({ valid: recordMatches, signature_valid: true, record_matches: recordMatches });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
