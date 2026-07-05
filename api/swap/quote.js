// POST /api/swap/quote  — start a cross-chain USDC transfer via CCTP (non-custodial).
//   GET  — list the CCTP chains/domains we support.
//   POST { from, to, amount, recipient } — returns the two source-chain transactions
//          (approve + burn) for the USER to sign. Liquid Flow signs nothing and holds
//          no funds; the minted USDC can only ever reach `recipient`.
const cctp = require('../_lib/cctp');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ chains: cctp.chainList(), usdc_decimals: cctp.USDC_DECIMALS });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { from, to, amount, recipient } = req.body || {};
  try {
    const plan = cctp.buildBurnPlan({ from, to, amount, recipient });
    return res.status(200).json(plan);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};
