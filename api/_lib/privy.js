const { PrivyClient } = require('@privy-io/node');

let client;

function configured() {
  return Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
}

function delegationConfigured() {
  return Boolean(
    configured()
    && process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY
    && process.env.PRIVY_SETTLEMENT_POLICY_ID
  );
}

function getClient() {
  if (!configured()) return null;
  if (!client) {
    client = new PrivyClient({
      appId: process.env.PRIVY_APP_ID,
      appSecret: process.env.PRIVY_APP_SECRET,
    });
  }
  return client;
}

async function provisionMerchant(email, merchantId) {
  const privy = getClient();
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

  // The user is the wallet owner. LiquidFlow is not the owner and cannot sign
  // until the merchant explicitly adds the restricted delegated signer.
  const wallet = await privy.wallets().create({
    chain_type: 'ethereum',
    owner: { user_id: user.id },
    display_name: 'LiquidFlow merchant settlement vault',
    external_id: merchantId,
    idempotency_key: merchantId,
  });

  return {
    userId: user.id,
    walletId: wallet.id,
    walletAddress: wallet.address,
    delegated: false,
  };
}

function settlementView(merchant) {
  const walletAddress = merchant && merchant.privyWalletAddress;
  const delegated = merchant && merchant.privyDelegated === true;
  let status = 'not_provisioned';
  if (walletAddress && !delegationConfigured()) status = 'awaiting_platform_authorization';
  if (walletAddress && delegationConfigured() && !delegated) status = 'awaiting_merchant_consent';
  if (walletAddress && delegationConfigured() && delegated) status = 'active';
  return {
    provider: 'PRIVY',
    custody: 'merchant_owned',
    status,
    vault_wallet: walletAddress || null,
    sweep_wallet: (merchant && merchant.payout) || null,
    automatic_sweep: status === 'active',
    restriction: 'approved assets may only settle to the registered sweep wallet',
  };
}

module.exports = {
  configured,
  delegationConfigured,
  provisionMerchant,
  settlementView,
};
