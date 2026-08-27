let client;

function configured() {
  return Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
}


async function getClient() {
  if (!configured()) return null;
  if (!client) {
    // Use Privy's ESM entry. Its CommonJS dependency path currently ships
    // incomplete HPKE files on clean serverless installs.
    const { PrivyClient } = await import('@privy-io/node');
    client = new PrivyClient({
      appId: process.env.PRIVY_APP_ID,
      appSecret: process.env.PRIVY_APP_SECRET,
    });
  }
  return client;
}

async function provisionMerchant(email, merchantId) {
  const privy = await getClient();
  if (!privy) return null;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  let user;
  try {
    user = await privy.users().getByEmailAddress({ address: normalizedEmail });
  } catch (error) {
    if (!error || error.status !== 404) throw error;
    user = await privy.users().create({
      linked_accounts: [{ type: 'email', address: normalizedEmail }],
    });
  }

  // The user is the wallet owner. LiquidFlow never receives or stores the key.
  const wallet = await privy.wallets().create({
    chain_type: 'ethereum',
    owner: { user_id: user.id },
    display_name: 'LiquidFlow merchant wallet',
    external_id: merchantId,
    idempotency_key: merchantId,
  });

  return {
    userId: user.id,
    walletId: wallet.id,
    walletAddress: wallet.address,
  };
}

function settlementView(merchant) {
  const walletAddress = merchant && merchant.privyWalletAddress;
  if (!merchant || !merchant.privyUserId) {
    return {
      provider: 'LEGACY',
      custody: 'merchant_controlled',
      status: 'legacy',
      primary_wallet: (merchant && merchant.payout) || null,
      sweep_wallet: (merchant && merchant.payout) || null,
      direct_settlement: true,
      control: 'legacy merchant keys',
    };
  }
  return {
    provider: 'PRIVY',
    custody: 'merchant_owned',
    status: walletAddress ? 'active' : 'not_provisioned',
    primary_wallet: walletAddress || null,
    deposit_wallet: walletAddress || null,
    sweep_wallet: null,
    direct_settlement: true,
    control: 'merchant_only',
    restriction: 'Only the authenticated merchant can sign transfers from the primary Privy wallet.',
  };
}

module.exports = {
  configured,
  provisionMerchant,
  settlementView,
};
