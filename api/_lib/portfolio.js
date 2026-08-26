const store = require('./store');
const { assetsForChain, confirmedBalance } = require('./chain');

async function buildPortfolio(merchant, key) {
  if (!merchant.privyUserId || !merchant.privyWalletAddress) {
    return { provider: 'LEGACY', wallets: [], holdings: [], balances: [], errors: [] };
  }

  const targets = new Map();
  const addTarget = (address, walletId, kind, chain, asset) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) return;
    const cfg = assetsForChain(chain).find(item => item.symbol.toUpperCase() === String(asset).toUpperCase());
    if (!cfg) return;
    const id = `${address.toLowerCase()}:${chain}:${cfg.symbol}`;
    targets.set(id, { address, wallet_id: walletId || null, kind, chain, asset: cfg.symbol, decimals: cfg.decimals, contract: cfg.contract });
  };

  for (const chain of merchant.chains || []) {
    for (const cfg of assetsForChain(chain)) {
      addTarget(merchant.privyWalletAddress, merchant.privyWalletId, 'primary', chain, cfg.symbol);
    }
  }

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
    const previous = totals.get(id) || { chain: item.chain, asset: item.asset, decimals: item.decimals, contract: item.contract, amount: 0n };
    previous.amount += BigInt(item.amount_base);
    totals.set(id, previous);
  }
  const balances = [...totals.values()].map(item => ({
    chain: item.chain,
    asset: item.asset,
    decimals: item.decimals,
    contract: item.contract,
    amount_base: item.amount.toString(),
  }));
  const wallets = [...new Map(holdings.map(item => [item.address.toLowerCase(), {
    address: item.address,
    wallet_id: item.wallet_id,
    kind: item.kind,
  }])).values()];

  return {
    provider: 'PRIVY',
    custody: 'merchant_owned',
    wallets,
    holdings,
    balances,
    payment_wallets_total: payments.length,
    payment_wallets_scanned: Math.min(payments.length, 50),
    errors: [...new Set(errors)],
  };
}

module.exports = { buildPortfolio };