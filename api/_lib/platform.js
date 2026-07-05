// Liquid Flow "merchant zero" — collects the onboarding fee so new gateways must pay
// (through our own payment system) before their API key becomes usable.
//
// Fee: 5 USDC on Arc (Arc's native token is USDC, 6 dp) for one month.
// Each signup gets a fresh stealth deposit address derived from the platform meta-keys,
// so the watcher confirms it exactly like any other payment. Funds are controlled by the
// platform spend key and swept to PLATFORM_WALLET.
//
// Env overrides (all optional; sensible testnet defaults below):
//   ONBOARD_FEE_USDC  — fee in whole USDC (default 5)
//   PLATFORM_WALLET   — sweep destination for collected fees
const store = require('./store');
const { generateKeypair, deriveDepositAddress } = require('./crypto');

const FEE_CHAIN    = 'eip155:5042002'; // Arc
const FEE_ASSET    = 'USDC';
const FEE_DECIMALS = 6;
const FEE_USDC     = Number(process.env.ONBOARD_FEE_USDC || '5');
const FEE_BASE     = String(Math.round(FEE_USDC * 10 ** FEE_DECIMALS));
const SWEEP_TO     = process.env.PLATFORM_WALLET || '0xCb789C8C16a5f8bd2C4502AAA5daAB00AD3c683a';

// Load (or, on first use, create) the platform stealth keypair. These are Liquid Flow's
// OWN revenue keys — storing the spend key server-side is fine (it moves LF's fees, never
// a user's funds). Sweeping collected fees to SWEEP_TO is a separate operational step.
async function getPlatform() {
  let p = await store.get('platform:onboarding');
  if (!p) {
    const kp = generateKeypair();
    p = {
      P_spend: kp.P_spend, P_view: kp.P_view,
      k_view:  kp.k_view,  k_spend: kp.k_spend,
      createdAt: Date.now(),
    };
    await store.set('platform:onboarding', p);
  }
  p.sweepTo = SWEEP_TO; // env may change the destination without rotating keys
  return p;
}

// Fresh onboarding invoice (unique deposit address) for a signing-up merchant.
async function createOnboardingInvoice(paymentId) {
  const p = await getPlatform();
  const { depositAddress, R } = deriveDepositAddress(p.P_spend, p.P_view, paymentId);
  return {
    depositAddress, R,
    amount: FEE_BASE, asset: FEE_ASSET, chain: FEE_CHAIN, decimals: FEE_DECIMALS,
  };
}

module.exports = { getPlatform, createOnboardingInvoice, FEE_CHAIN, FEE_ASSET, FEE_DECIMALS, FEE_BASE, FEE_USDC, SWEEP_TO };
