// On-chain balance checks + on-demand confirmation.
// Lets the frontend (dashboard / donate polling) confirm a real testnet deposit
// within seconds instead of waiting for the daily cron.
const store = require('./store');
const { confirmPayment } = require('./confirm');

// RPC resolution. Real-money (mainnet) chains MUST be given an explicit RPC via env:
// we refuse to settle real funds against a shared, rate-limited public endpoint that
// can throttle us or serve a stale/manipulated balance right at confirmation time.
// Testnets keep convenient public fallbacks for local/CI work.
const RPC_ENV = {
  'eip155:84532':    process.env.BASE_SEPOLIA_RPC,
  'eip155:8453':     process.env.BASE_MAINNET_RPC,
  'eip155:5042002':  process.env.ARC_TESTNET_RPC,       // Circle Arc testnet (native gas: USDC, 6 dp)
  'eip155:11155111': process.env.ETHEREUM_SEPOLIA_RPC,
  'eip155:1':        process.env.ETHEREUM_MAINNET_RPC,
  'solana':          process.env.SOLANA_RPC,
  'sui':             process.env.SUI_RPC,
};
const RPC_FALLBACK = {
  'eip155:84532':    'https://sepolia.base.org',
  'eip155:5042002':  'https://rpc.testnet.arc.network',
  'eip155:11155111': 'https://ethereum-sepolia-rpc.publicnode.com',
  'solana':          'https://api.devnet.solana.com',
  'sui':             'https://fullnode.testnet.sui.io',
};
// Chains that move real money — no public fallback allowed.
const MAINNET_CHAINS = new Set(['eip155:1', 'eip155:8453']);
function rpcUrl(chain) {
  const env = RPC_ENV[chain];
  if (env) return env;
  if (MAINNET_CHAINS.has(chain)) {
    throw new Error(`mainnet chain ${chain} requires an explicit RPC env var (no public fallback for real money)`);
  }
  return RPC_FALLBACK[chain] || null;
}
// Back-compat display map (mainnet entries are null until their env var is set).
const RPC = {};
for (const c of Object.keys(RPC_ENV)) { try { RPC[c] = rpcUrl(c); } catch { RPC[c] = null; } }

// Reorg-safe confirmation depth per chain. On EVM we read the balance at
// (latest - N) so a payment only confirms once its funds are buried N blocks deep;
// a shallow reorg can no longer reverse an already-"confirmed" payment. Mainnet
// values are deliberately higher than testnet.
const CONFIRMATIONS = {
  'eip155:84532': 3, 'eip155:8453': 30, 'eip155:5042002': 3, 'eip155:11155111': 3, 'eip155:1': 24,
  'solana': 1, 'sui': 1,
};
const confDepth = (c) => (CONFIRMATIONS[c] != null ? CONFIRMATIONS[c] : 3);

// Solana & Sui settle through the ed25519 stealth scheme, which is UNAUDITED and
// carries a known key-recoverability risk (raw-scalar keys standard wallets can't
// import). It stays hard-disabled until GO-LIVE Phase 5's crypto audit clears it,
// so mainnet cannot silently lose funds. Flip ENABLE_ED25519_STEALTH=1 only after.
const ED25519_STEALTH_ENABLED = process.env.ENABLE_ED25519_STEALTH === '1';
function chainSupported(chain) {
  if (!chain) return false;
  if (chain === 'solana' || chain === 'sui') return ED25519_STEALTH_ENABLED;
  return String(chain).startsWith('eip155:');
}
function chainDisabledReason(chain) {
  if ((chain === 'solana' || chain === 'sui') && !ED25519_STEALTH_ENABLED) {
    return 'Solana and Sui are temporarily disabled pending the stealth-cryptography audit';
  }
  return `${chain} is not supported`;
}

// Native-asset decimals + symbol per chain (for amount<->base-unit conversion + display).
const DECIMALS = {
  'eip155:84532': 18, 'eip155:8453': 18, 'eip155:11155111': 18, 'eip155:1': 18,
  'eip155:5042002': 6,   // Arc — native gas is USDC (6 decimals)
  'solana': 9, 'sui': 9, // SOL (lamports) / SUI (MIST)
};
const SYMBOL = {
  'eip155:84532': 'ETH', 'eip155:8453': 'ETH', 'eip155:11155111': 'ETH', 'eip155:1': 'ETH',
  'eip155:5042002': 'USDC', 'solana': 'SOL', 'sui': 'SUI',
};
const decimals = (c) => DECIMALS[c] != null ? DECIMALS[c] : 18;
const symbol   = (c) => SYMBOL[c] || 'ETH';
const toHuman  = (amount, c) => Number(BigInt(amount || '0')) / Math.pow(10, decimals(c));

// Amounts are base-unit integers (wei / lamports / USDC-6dp), carried as strings.
// Reject anything that is not a plain positive decimal integer: no "0", no hex
// ("0xff"), no decimal point, no scientific notation ("1e18"), no negatives, no
// whitespace. Without this, amount="0" or "-1" makes the balance check
// `bal >= BigInt(amount)` trivially true and a payment confirms with zero funds.
const MAX_BASE = 10n ** 36n; // sanity ceiling — far above any real settlement
function isValidBaseAmount(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return false;
  const s = String(v).trim();
  if (!/^[0-9]+$/.test(s)) return false;          // digits only — blocks 0x, 1e18, -1, 1.5, ""
  let n;
  try { n = BigInt(s); } catch { return false; }
  return n > 0n && n < MAX_BASE;
}

// Asset policy (single source of truth): each chain settles in exactly ONE asset —
// its native token. Arc's native gas token IS USDC (6 dp), so Arc settles in USDC;
// every other chain settles in its native coin. No ERC-20/SPL tokens elsewhere yet.
const assetForChain = (c) => SYMBOL[c] || null;
const assetOk = (c, asset) =>
  !!asset && !!assetForChain(c) &&
  String(asset).toUpperCase() === assetForChain(c).toUpperCase();

async function rpc(chain, method, params = []) {
  const url = rpcUrl(chain);
  if (!url) throw new Error(`no RPC for chain ${chain}`);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// EVM balance at a reorg-safe depth: read at (latest - confirmations) so only funds
// buried that deep are counted. confirmations = 0 reads the chain tip ('latest').
async function ethBalance(chain, address, confirmations = 0) {
  let tag = 'latest';
  if (confirmations > 0) {
    const head   = BigInt(await rpc(chain, 'eth_blockNumber', []));
    const target = head > BigInt(confirmations) ? head - BigInt(confirmations) : 0n;
    tag = '0x' + target.toString(16);
  }
  return BigInt(await rpc(chain, 'eth_getBalance', [address, tag]));
}

// Native-asset balance (smallest units) for any supported chain — EVM, Solana, Sui.
// `confirmations` selects a reorg-safe view: block depth on EVM, 'finalized'
// commitment on Solana. 0 = latest/unconfirmed.
async function nativeBalance(chain, address, confirmations = 0) {
  if (chain.startsWith('eip155:')) return ethBalance(chain, address, confirmations);
  if (chain === 'solana') {                       // lamports
    const cfg = confirmations > 0 ? [address, { commitment: 'finalized' }] : [address];
    const r = await rpc('solana', 'getBalance', cfg);
    return BigInt((r && r.value) || 0);
  }
  if (chain === 'sui') {                           // MIST
    const r = await rpc('sui', 'suix_getBalance', [address]);
    return BigInt((r && r.totalBalance) || 0);
  }
  throw new Error(`unsupported chain ${chain}`);
}

// Balance viewed at this chain's confirmation depth — the value confirmation logic
// must use, so a payment is only ever confirmed against reorg-safe funds.
async function confirmedBalance(chain, address) {
  return nativeBalance(chain, address, confDepth(chain));
}

// Check one payment on-chain; confirm it if funded, expire it if past its window.
// Returns the (possibly mutated) payment. Safe to call on any status.
async function checkAndConfirm(payment) {
  if (!payment || payment.status !== 'awaiting_payment') return payment;

  // A malformed/zero/negative amount must never confirm. Guard here too so a bad
  // record that slipped past creation validation can't confirm against `bal >= 0`.
  if (!isValidBaseAmount(payment.amount)) return payment;

  if (Date.now() > payment.expiresAt) {
    payment.status = 'expired';
    await store.set(`payment:${payment.id}`, payment);
    await store.srem('payments:pending', payment.id);
    return payment;
  }

  try {
    // Read at the chain's confirmation depth — funds must be buried N blocks/final
    // before they count, so a shallow reorg cannot reverse a confirmed payment.
    const bal  = await confirmedBalance(payment.chain, payment.depositAddress);
    const need = BigInt(payment.amount);

    // Stealth mode derives a FRESH single-use address per payment, so the address
    // only ever holds this one payment — a raw balance check is sound.
    //
    // Instant mode reuses the merchant's static payout wallet as the deposit
    // address. That wallet carries an arbitrary standing balance from other
    // sources, so `bal >= amount` would confirm off pre-existing funds (no real
    // payment) or let one incoming transfer satisfy several invoices. We instead
    // require the balance to have RISEN by at least `amount` versus the baseline
    // captured when the payment was created.
    let funded;
    if (payment.mode === 'stealth') {
      funded = bal >= need;                 // fresh single-use address
    } else {
      // Instant mode reuses the merchant's payout wallet, so we require a baseline
      // captured at creation and a genuine RISE of >= amount. No baseline → fail
      // closed (leave pending); never confirm an instant payment against pre-existing
      // funds. New instant payments always have a baseline (enforced at creation).
      if (payment.baselineBalance == null) return payment;
      const baseline = BigInt(payment.baselineBalance);
      funded = bal >= baseline + need;
    }

    if (funded) {
      await confirmPayment(payment, CONFIRMATIONS[payment.chain] || 3);
    }
  } catch (e) {
    // unsupported chain or RPC hiccup — leave pending; next poll/cron retries
  }
  return payment;
}

module.exports = { RPC, CONFIRMATIONS, DECIMALS, SYMBOL, decimals, symbol, toHuman, isValidBaseAmount, chainSupported, chainDisabledReason, assetForChain, assetOk, rpc, rpcUrl, ethBalance, nativeBalance, confirmedBalance, checkAndConfirm };
