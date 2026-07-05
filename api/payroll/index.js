// /api/payroll
//   POST — register a payroll contract the business deployed (so the keeper watches it)
//   GET  — list payroll contracts for ?company=<address>
const store = require('../_lib/store');
const { operatorAddress, readRoles } = require('../_lib/payroll');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const company = String(req.query.company || '').toLowerCase();
    if (!isAddr(company)) return res.status(400).json({ error: 'valid ?company address required' });
    const addrs = await store.smembers(`payrolls:company:${company}`);
    const items = [];
    for (const a of addrs) {
      const meta = await store.get(`payroll:${a}`);
      if (meta) items.push(meta);
    }
    items.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    return res.status(200).json({ payrolls: items });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { contract, company, name, token, decimals, symbol } = req.body || {};
  if (!isAddr(contract) || !isAddr(company)) {
    return res.status(400).json({ error: 'valid contract and company addresses required' });
  }

  // First-writer-wins: never let a later caller overwrite an existing registration.
  // Overwriting let an attacker flip a native payroll's meta to `token`, forcing the
  // keeper down the ERC-20 releaseBatch path (which reverts) and stalling real payouts.
  const existing = await store.get(`payroll:${contract}`);
  if (existing) {
    if (existing.company !== company.toLowerCase()) {
      return res.status(409).json({ error: 'contract already registered to a different company' });
    }
    return res.status(200).json({ ok: true, ...existing }); // idempotent, no mutation
  }

  // Verify on-chain that this is a real payroll whose trigger IS our operator. This
  // ties registration to reality: the keeper only ever spends gas on contracts that
  // actually opted into LF, and it blocks spam registration of arbitrary addresses.
  const opAddr = operatorAddress();
  try {
    const roles = await readRoles(contract);
    if (roles.company !== company.toLowerCase()) {
      return res.status(400).json({ error: 'company does not match the contract on-chain' });
    }
    if (opAddr && roles.trigger !== opAddr) {
      return res.status(400).json({ error: 'contract trigger is not the Liquid Flow keeper; deploy with the correct trigger address' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'could not verify contract on-chain: ' + e.message });
  }

  const meta = {
    contract,
    company: company.toLowerCase(),
    name: name || 'Payroll',
    token: isAddr(token) ? token : null,      // ERC-20 token address (null = native)
    decimals: token ? (Number(decimals) || 6) : 18,
    symbol: token ? (symbol || 'USDC') : 'ETH',
    createdAt: Date.now(),
  };
  await store.set(`payroll:${contract}`, meta);
  await store.sadd('payrolls:all', contract);
  await store.sadd(`payrolls:company:${company.toLowerCase()}`, contract);

  return res.status(201).json({ ok: true, ...meta });
};
