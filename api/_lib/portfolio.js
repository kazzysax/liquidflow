const { assetsForChain, confirmedBalance } = require('./chain');

async function buildPortfolio(merchant) {
  if (!merchant.privyUserId || !merchant.privyWalletAddress) {
    return { provider: 'LEGACY', primary_wallet: null, wallets: [], holdings: [], balances: [], errors: [] };
  }

  const wallets = [{
    address: merchant.privyWalletAddress,
    wallet_id: merchant.privyWalletId || null,
    kind: 'primary',
    slot: 0,
  }, ...(merchant.privyPaymentWallets || []).map(wallet => ({
    address: wallet.walletAddress,
    wallet_id: wallet.walletId,
    kind: 'payment',
    slot: wallet.slot,
  }))];
  const targets = [];
  for (const wallet of wallets) {
    for (const chain of merchant.chains || []) {
      for (const cfg of assetsForChain(chain)) {
        targets.push({
          ...wallet,
          chain,
          asset: cfg.symbol,
          decimals: cfg.decimals,
          contract: cfg.contract,
        });
      }
    }
  }

  const results = await Promise.allSettled(targets.map(async target => ({
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
    const key = `${item.chain}:${item.asset}`;
    const current = totals.get(key) || { chain: item.chain, asset: item.asset, decimals: item.decimals, contract: item.contract, amount: 0n };
    current.amount += BigInt(item.amount_base || '0');
    totals.set(key, current);
  }
  const balances = [...totals.values()].map(item => ({
    chain: item.chain,
    asset: item.asset,
    decimals: item.decimals,
    contract: item.contract,
    amount_base: item.amount.toString(),
  }));

  return {
    provider: 'PRIVY',
    custody: 'merchant_owned',
    delivery: 'rotating_pool_then_primary',
    primary_wallet: merchant.privyWalletAddress,
    wallets,
    holdings,
    balances,
    errors: [...new Set(errors)],
  };
}

module.exports = { buildPortfolio };