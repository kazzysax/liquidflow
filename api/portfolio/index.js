const store = require('../_lib/store');
const { assetsForChain, confirmedBalance } = require('../_lib/chain');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function apiKey(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const key = apiKey(req);
  const merchant = await store.get(`merchant:${key}`);
  if (!merchant) return res.status(401).json({ error: 'invalid api key' });
  if (!merchant.privyUserId || !merchant.privyWalletAddress) {
    return res.status(200).json({ provider: 'LEGACY', wallets: [], balances: [], errors: [] });
  }

  const targets = new Map();
  const addTarget = (address, walletId, kind, chain, asset) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) return;
    const cfg = assetsForChain(chain).find(item => item.symbol.toUpperCase() === String(asset).toUpperCase());
    if (!cfg) return;
    const id = `${address.toLowerCase()}:${chain}:${cfg.symbol}`;
    targets.set(id, { address, wallet_id: walletId || null, kind, chain, asset: cfg.symbol, decimals: cfg.decimals, contract: cfg.contract });
  };

  // The primary wallet can receive any enabled LiquidFlow asset.
  for (const chain of merchant.chains || []) {
    for (const cfg of assetsForChain(chain)) {
      addTarget(merchant.privyWalletAddress, merchant.privyWalletId, 'primary', chain, cfg.symbol);
    }
  }

  // Private checkout wallets are scoped to the asset/network of their invoice.
  // Newest-first and bounded keeps the endpoint responsive on serverless hosting.
  const ids = await store.smembers(`merchant:${key}:payments`);
  const payments = [];
  for (const id of ids) {
    const payment = await store.get(`payment:${id}`);
    if (payment && payment.walletProvider === 'PRIVY') payments.push(payment);
  }
  payments.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const payment of payments.slice(0, 50)) {
    addTarget(payment.depositAddress, payment.privyWalletId, 'private_payment', payment.chain, payment.asset);
  }

  const results = await Promise.allSettled([...targets.values()].map(async target => ({
    ...target,
    amount_base: (await confirmedBalance(target.chain, target.address, target.asset)).toString(),
  })));
  const holdings = [];
  const errors = [];
  for (const result of results) {
    if (result.status === 'fulfilled') holdings.push(result.value);
    else errors.push('A network balance could not be refreshed.');
  }

  const totals = new Map();
  for (const item of holdings) {
    const id = `${item.chain}:${item.asset}`;
    const prev = totals.get(id) || { chain: item.chain, asset: item.asset, decimals: item.decimals, contract: item.contract, amount: 0n };
    prev.amount += BigInt(item.amount_base);
    totals.set(id, prev);
  }

  const wallets = [...new Map(holdings.map(item => [item.address.toLowerCase(), {
    address: item.address,
    wallet_id: item.wallet_id,
    kind: item.kind,
  }])).values()];

  return res.status(200).json({
    provider: 'PRIVY',
    custody: 'merchant_owned',
    wallets,
    holdings,
    balances: [...totals.values()].map(item => ({ ...item, amount_base: item.amount.toString(), amount: undefined })),
    payment_wallets_total: payments.length,
    payment_wallets_scanned: Math.min(payments.length, 50),
    errors: [...new Set(errors)],
  });
};