const { assetsForChain, confirmedBalance } = require('./chain');

async function buildPortfolio(merchant) {
  if (!merchant.privyUserId || !merchant.privyWalletAddress) {
    return { provider: 'LEGACY', primary_wallet: null, wallets: [], holdings: [], balances: [], errors: [] };
  }

  const targets = [];
  for (const chain of merchant.chains || []) {
    for (const cfg of assetsForChain(chain)) {
      targets.push({
        address: merchant.privyWalletAddress,
        wallet_id: merchant.privyWalletId || null,
        kind: 'primary',
        chain,
        asset: cfg.symbol,
        decimals: cfg.decimals,
        contract: cfg.contract,
      });
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

  const balances = holdings.map(item => ({
    chain: item.chain,
    asset: item.asset,
    decimals: item.decimals,
    contract: item.contract,
    amount_base: item.amount_base,
  }));

  return {
    provider: 'PRIVY',
    custody: 'merchant_owned',
    delivery: 'direct_to_primary',
    primary_wallet: merchant.privyWalletAddress,
    wallets: [{
      address: merchant.privyWalletAddress,
      wallet_id: merchant.privyWalletId || null,
      kind: 'primary',
    }],
    holdings,
    balances,
    errors: [...new Set(errors)],
  };
}

module.exports = { buildPortfolio };