// GET /api/payroll/:contract
//   Reads the payroll's payouts + balances from chain, and (on-demand keeper)
//   releases any payouts that are now due — so a viewer always sees current state.
const store = require('../_lib/store');
const { readPayroll, releaseDue, EXPLORER } = require('../_lib/payroll');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const { contract } = req.query;
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract || '')) {
    return res.status(400).json({ error: 'invalid contract address' });
  }

  const meta = await store.get(`payroll:${contract}`);

  let released = [];
  // Only auto-release for REGISTERED payrolls. Registration verifies the contract
  // names our operator as its trigger, so this can't be used to make the operator
  // key fire gas-paying calls at an arbitrary attacker-supplied contract. Reads of
  // unregistered contracts are still allowed (view-only) below. ?readonly=1 skips it.
  if (meta && req.query.readonly !== '1') {
    try { released = await releaseDue(contract, meta); } catch (e) { /* keeper best-effort */ }
  }

  try {
    const data = await readPayroll(contract, meta);
    return res.status(200).json({ ...data, just_released: released, explorer: `${EXPLORER}/address/${contract}` });
  } catch (e) {
    return res.status(404).json({ error: 'could not read payroll contract: ' + e.message });
  }
};
