// POST /api/swap/relay-mint  { to, message, attestation }
//
// OPTIONAL convenience: Liquid Flow submits the final mint on the destination chain so
// the recipient doesn't need gas there. This is non-custodial — CCTP's receiveMessage
// mints only to the recipient fixed at burn time, so the relayer cannot redirect funds;
// it just pays gas. Disabled unless an operator key is configured.
//
// Because this spends the operator's gas, it's gated behind a server-side secret
// (SWAP_RELAY_SECRET) so it can't be invoked freely by the public.
const cctp = require('../_lib/cctp');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // Relaying spends real gas from the operator wallet — require an explicit secret.
  const secret = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.SWAP_RELAY_SECRET || secret !== process.env.SWAP_RELAY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { to, message, attestation } = req.body || {};
  try {
    const result = await cctp.relayMint({ to, message, attestation });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};
