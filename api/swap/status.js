// GET /api/swap/status?domain=<sourceDomain>&tx=<burnTxHash>
// Reads Circle's attestation service for a burn transaction. Read-only, no custody.
// When status is "complete", returns the message + attestation the mint step needs.
const cctp = require('../_lib/cctp');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const domain = req.query.domain;
  const tx     = req.query.tx;
  if (domain == null || !/^\d+$/.test(String(domain))) {
    return res.status(400).json({ error: 'valid ?domain (source CCTP domain id) is required' });
  }
  if (!tx) return res.status(400).json({ error: 'valid ?tx (burn transaction hash) is required' });

  try {
    const att = await cctp.getAttestation(domain, tx);
    return res.status(200).json({
      ready: att.status === 'complete',
      status: att.status,
      message: att.message,
      attestation: att.attestation,
      event_nonce: att.event_nonce,
      note: att.status === 'complete'
        ? 'Attestation ready. Submit receiveMessage(message, attestation) on the destination chain, or POST /api/swap/relay-mint to have Liquid Flow relay it.'
        : 'Not ready yet — keep polling until status is "complete".',
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};
