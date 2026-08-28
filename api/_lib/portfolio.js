const { assetsForChain, confirmedBalance, nativeBalance } = require('./chain');

const GAS = Object.freeze({
  'eip155:1': { symbol: 'ETH', minimum: 500000000000000n },
  'eip155:137': { symbol: 'POL', minimum: 50000000000000000n },
  'eip155:8453': { symbol: 'ETH', minimum: 50000000000000n },
});

async function buildPortfolio(merchant) {
  if (!merchant.privyUserId || !merchant.privyWalletAddress) {
    return { provider: 'LEGACY', primary_wallet: null, wallets: [], holdings: [], balances: [], gas_balances: [], errors: [] };
  }

  const wallet = {
    address: merchant.privyWalletAddress,
    wallet_id: merchant.privyWalletId || null,
    kind: 'primary',
    slot: 0,
  };
  const targets = [];
  for (const chain of merchant.chains || []) {
    for (const cfg of assetsForChain(chain)) {
      targets.push({ ...wallet, chain, asset: cfg.symbol, decimals: cfg.decimals, contract: cfg.contract });
    }
  }

  const [tokenResults, gasResults] = await Promise.all([
    Promise.allSettled(targets.map(async target => ({
      ...target,
      amount_base: (await confirmedBalance(target.chain, target.address, target.asset)).toString(),
    }))),
    Promise.allSettled((merchant.chains || []).filter(chain => GAS[chain]).map(async chain => {
      const amount = await nativeBalance(chain, wallet.address);
      return {
        chain,
        symbol: GAS[chain].symbol,
        decimals: 18,
        amount_base: amount.toString(),
        minimum_base: GAS[chain].minimum.toString(),
        ready: amount >= GAS[chain].minimum,
      };
    })),
  ]);

  const holdings = [];
  const gasBalances = [];
  const errors = [];
  for (const result of tokenResults) {
    if (result.status === 'fulfilled') holdings.push(result.value);
    else errors.push('A primary-wallet token balance could not be refreshed.');
  }
  for (const result of gasResults) {
    if (result.status === 'fulfilled') gasBalances.push(result.value);
    else errors.push('A primary-wallet gas balance could not be refreshed.');
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
    wallets: [wallet],
    holdings,
    balances,
    gas_balances: gasBalances,
    consolidation_required: false,
    errors: [...new Set(errors)],
  };
}

module.exports = { buildPortfolio };