// On-chain balance checks + on-demand confirmation.
// Lets the frontend (dashboard / donate polling) confirm a real testnet deposit
// within seconds instead of waiting for the daily cron.
const store = require('./store');
const { confirmPayment } = require('./confirm');

// One authoritative customer-payment window shared by checkout and donations.
const CHECKOUT_TTL_MS = 10 * 60 * 1000;

// RPC resolution. Real-money (mainnet) chains MUST be given an explicit RPC via env:
// we refuse to settle real funds against a shared, rate-limited public endpoint that
// can throttle us or serve a stale/manipulated balance right at confirmation time.
// Testnets keep convenient public fallbacks for local/CI work.
const RPC_ENV = {
  'eip155:84532':    process.env.BASE_SEPOLIA_RPC,
  'eip155:8453':     process.env.BASE_MAINNET_RPC,
  'eip155:137':      process.env.POLYGON_MAINNET_RPC,
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
const MAINNET_CHAINS = new Set(['eip155:1', 'eip155:137', 'eip155:8453']);
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
  'eip155:84532': 3, 'eip155:8453': 30, 'eip155:137': 128, 'eip155:5042002': 3, 'eip155:11155111': 3, 'eip155:1': 24,
  'solana': 1, 'sui': 1,
};
const confDepth = (c) => (CONFIRMATIONS[c] != null ? CONFIRMATIONS[c] : 3);

// Solana & Sui settle through the ed25519 stealth scheme, which is UNAUDITED and
// carries a known key-recoverability risk (raw-scalar keys standard wallets can't
// import). It stays hard-disabled until GO-LIVE Phase 5's crypto audit clears it,
// so mainnet cannot silently lose funds. Flip ENABLE_ED25519_STEALTH=1 only after.
const ED25519_STEALTH_ENABLED = process.env.ENABLE_ED25519_STEALTH === '1';
function chainSupported(chain) {
  return !!(chain && ASSETS[chain]);
}
function chainDisabledReason(chain) {
  return `${chain} is not an approved LiquidFlow mainnet`;
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

// Buildathon mainnet allowlist. Contract addresses are canonical issuer addresses;
// callers cannot supply arbitrary token contracts. Symbols are normalized so Polygon
// VERSE is stored as fxVERSE while still accepting "VERSE" from API clients.
const ASSETS = Object.freeze({
  'eip155:1': Object.freeze({
    VERSE: Object.freeze({ symbol: 'VERSE', decimals: 18, contract: '0x249ca82617ec3dfb2589c4c17ab7ec9765350a18' }),
    USDC:  Object.freeze({ symbol: 'USDC',  decimals: 6,  contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }),
  }),
  'eip155:137': Object.freeze({
    VERSE:   Object.freeze({ symbol: 'fxVERSE', decimals: 18, contract: '0xc708D6F2153933DAA50B2D0758955Be0A93A8FEc' }),
    FXVERSE: Object.freeze({ symbol: 'fxVERSE', decimals: 18, contract: '0xc708D6F2153933DAA50B2D0758955Be0A93A8FEc' }),
    USDC:    Object.freeze({ symbol: 'USDC',    decimals: 6,  contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' }),
  }),
  'eip155:8453': Object.freeze({
    USDC: Object.freeze({ symbol: 'USDC', decimals: 6, contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }),
  }),
});
function assetConfig(chain, asset) {
  const key = String(asset || '').toUpperCase();
  return (ASSETS[chain] && ASSETS[chain][key]) || null;
}
const assetsForChain = (chain) => {
  const seen = new Set();
  return Object.values(ASSETS[chain] || {}).filter(a => !seen.has(a.contract.toLowerCase()) && seen.add(a.contract.toLowerCase()));
};
const assetForChain = (chain) => assetsForChain(chain).map(a => a.symbol);
const assetOk = (chain, asset) => !!assetConfig(chain, asset);

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

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ACTIVE_PAYMENT_STATUSES = new Set(['awaiting_payment', 'awaiting_topup', 'checking_finality']);
const FINALITY_GRACE_MS = CHECKOUT_TTL_MS;

async function currentBlock(chain) {
  if (!String(chain).startsWith('eip155:')) throw new Error('event accounting requires an EVM chain');
  return BigInt(await rpc(chain, 'eth_blockNumber', []));
}

async function tokenTransfersTo(payment) {
  const cfg = assetConfig(payment.chain, payment.asset);
  if (!cfg || payment.startBlock == null) throw new Error('payment is missing token or start block');
  const head = await currentBlock(payment.chain);
  const safe = head > BigInt(confDepth(payment.chain)) ? head - BigInt(confDepth(payment.chain)) : 0n;
  const from = BigInt(payment.startBlock);
  if (safe < from) return [];
  const recipient = '0x' + String(payment.depositAddress).slice(2).toLowerCase().padStart(64, '0');
  const logs = await rpc(payment.chain, 'eth_getLogs', [{ address: cfg.contract,
    fromBlock: '0x' + from.toString(16), toBlock: '0x' + safe.toString(16),
    topics: [TRANSFER_TOPIC, null, recipient] }]);
  if (!Array.isArray(logs) || logs.length > 100) throw new Error('unexpected transfer log count');
  return logs.map(log => ({ id: `${log.transactionHash}:${log.logIndex}`, txHash: log.transactionHash,
    logIndex: log.logIndex, blockNumber: BigInt(log.blockNumber).toString(),
    from: '0x' + String(log.topics[1]).slice(-40), amount: BigInt(log.data).toString() }));
}

function classifyTransfers(payment, transfers, now = Date.now()) {
  const need = BigInt(payment.amount);
  const unique = [...new Map((transfers || []).map(t => [t.id, t])).values()];
  const senders = [...new Set(unique.map(t => t.from.toLowerCase()))];
  const received = unique.reduce((sum, t) => sum + BigInt(t.amount), 0n);
  if (senders.length > 1) return { status: 'manual_review', received, sender: null, refund: null };
  if (received === need) return { status: 'confirmed', received, sender: senders[0] || null, refund: null };
  if (received > need) return { status: 'refund_pending', received, sender: senders[0], refund: received - need };
  if (received > 0n && (payment.expiresAt == null || now < payment.expiresAt)) return { status: 'awaiting_topup', received, sender: senders[0], refund: null };
  if (payment.expiresAt != null && now < payment.expiresAt + FINALITY_GRACE_MS) return { status: 'checking_finality', received, sender: senders[0] || null, refund: null };
  if (received > 0n) return { status: 'refund_pending', received, sender: senders[0], refund: received };
  return { status: payment.expiresAt == null ? 'awaiting_payment' : 'expired', received, sender: null, refund: null };
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

async function tokenBalance(chain, token, address, confirmations = 0) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) throw new Error('invalid EVM address');
  let tag = 'latest';
  if (confirmations > 0) {
    const head = BigInt(await rpc(chain, 'eth_blockNumber', []));
    const target = head > BigInt(confirmations) ? head - BigInt(confirmations) : 0n;
    tag = '0x' + target.toString(16);
  }
  // balanceOf(address) selector + 32-byte left-padded address.
  const data = '0x70a08231' + String(address).slice(2).toLowerCase().padStart(64, '0');
  const result = await rpc(chain, 'eth_call', [{ to: token, data }, tag]);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(result || ''))) throw new Error('invalid ERC-20 balance response');
  return BigInt(result);
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
async function confirmedBalance(chain, address, asset) {
  const cfg = assetConfig(chain, asset);
  if (!cfg) throw new Error(`unsupported asset ${asset} on ${chain}`);
  return tokenBalance(chain, cfg.contract, address, confDepth(chain));
}

// Check one payment on-chain; confirm it if funded, expire it if past its window.
// Returns the (possibly mutated) payment. Safe to call on any status.
async function checkAndConfirm(payment) {
  if (!payment || !ACTIVE_PAYMENT_STATUSES.has(payment.status)) return payment;

  // A malformed/zero/negative amount must never confirm. Guard here too so a bad
  // record that slipped past creation validation can't confirm against `bal >= 0`.
  if (!isValidBaseAmount(payment.amount)) return payment;

  try {
    const transfers = await tokenTransfersTo(payment);
    const result = classifyTransfers(payment, transfers);
    payment.transfers = transfers;
    payment.receivedAmount = result.received.toString();
    payment.payerAddress = result.sender;
    payment.transactionHashes = [...new Set(transfers.map(t => t.txHash))];
    if (result.status === 'confirmed') {
      await confirmPayment(payment, CONFIRMATIONS[payment.chain] || 3);
    } else {
      payment.status = result.status;
      if (result.refund != null) {
        payment.refund = { status: 'merchant_authorization_required', amount: result.refund.toString(), to: result.sender, createdAt: Date.now() };
        await store.sadd('refunds:pending', payment.id);
      }
      await store.set(`payment:${payment.id}`, payment);
      if (!ACTIVE_PAYMENT_STATUSES.has(payment.status)) await store.srem('payments:pending', payment.id);
    }
  } catch (e) {
    // unsupported chain or RPC hiccup — leave pending; next poll/cron retries
  }
  return payment;
}

module.exports = { CHECKOUT_TTL_MS, RPC, CONFIRMATIONS, ASSETS, DECIMALS, SYMBOL, ACTIVE_PAYMENT_STATUSES, decimals, symbol, toHuman, isValidBaseAmount, chainSupported, chainDisabledReason, assetConfig, assetsForChain, assetForChain, assetOk, rpc, rpcUrl, currentBlock, ethBalance, tokenBalance, nativeBalance, confirmedBalance, tokenTransfersTo, classifyTransfers, checkAndConfirm };
