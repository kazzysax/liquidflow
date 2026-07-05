// Payroll keeper helpers (native + ERC-20/USDC). Liquid Flow holds ONLY the
// trigger key — it can call release/releaseBatch on due, company-defined payouts,
// and nothing else. Non-custodial: it can never change recipients/amounts,
// redirect funds, or release early.
const { ethers } = require('ethers');

const RPC = process.env.ETHEREUM_SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
const EXPLORER = 'https://sepolia.etherscan.io';
const CHAIN = 'eip155:11155111';

// Superset ABI — native PayrollScheduler lacks balance()/releaseBatch(); we only
// call those on ERC-20 payrolls.
const ABI = [
  'function company() view returns (address)',
  'function trigger() view returns (address)',
  'function payoutCount() view returns (uint256)',
  'function allocated() view returns (uint256)',
  'function balance() view returns (uint256)',
  'function getPayout(uint256) view returns (address recipient, uint256 amount, uint64 releaseTime, bool released, bool cancelled)',
  'function release(uint256 id)',
  'function releaseBatch(uint256[] ids)',
];

function provider() { return new ethers.JsonRpcProvider(RPC); }
function operator() {
  if (!process.env.LF_OPERATOR_KEY) throw new Error('LF_OPERATOR_KEY not set');
  return new ethers.Wallet(process.env.LF_OPERATOR_KEY, provider());
}

// The address the keeper releases from. Prefer an explicit env (no private key
// needed at request time); fall back to deriving it from the operator key.
function operatorAddress() {
  if (process.env.LF_OPERATOR_ADDRESS) return process.env.LF_OPERATOR_ADDRESS.toLowerCase();
  if (process.env.LF_OPERATOR_KEY) return new ethers.Wallet(process.env.LF_OPERATOR_KEY).address.toLowerCase();
  return null;
}

// Read a payroll contract's on-chain company + trigger. Used to verify a
// registration is real (the contract actually named our operator as its trigger)
// before the keeper will ever touch it.
async function readRoles(addr) {
  const c = new ethers.Contract(addr, ABI, provider());
  const [company, trigger] = await Promise.all([c.company(), c.trigger()]);
  return { company: String(company).toLowerCase(), trigger: String(trigger).toLowerCase() };
}

function metaToken(meta) {
  meta = meta || {};
  const erc20 = !!meta.token;
  return {
    erc20,
    decimals: erc20 ? (meta.decimals || 6) : 18,
    symbol:   erc20 ? (meta.symbol || 'USDC') : 'ETH',
  };
}
const toHuman = (base, dec) => Number(base) / Math.pow(10, dec);

// Read all payouts + contract state (read-only).
async function readPayroll(addr, meta) {
  const t = metaToken(meta);
  const p = provider();
  const c = new ethers.Contract(addr, ABI, p);
  const [company, trigger, count, allocated, bal] = await Promise.all([
    c.company(), c.trigger(), c.payoutCount(), c.allocated(),
    t.erc20 ? c.balance() : p.getBalance(addr),
  ]);
  const payouts = [];
  for (let id = 0; id < Number(count); id++) {
    const po = await c.getPayout(id);
    payouts.push({
      id,
      recipient: po[0],
      amount: po[1].toString(),
      amount_human: toHuman(po[1].toString(), t.decimals),
      release_time: Number(po[2]),
      released: po[3],
      cancelled: po[4],
    });
  }
  return {
    contract: addr,
    company, trigger,
    chain: CHAIN,
    token: t.erc20 ? meta.token : null,
    decimals: t.decimals,
    symbol: t.symbol,
    balance: toHuman(bal.toString(), t.decimals),
    balance_base: bal.toString(),
    allocated: toHuman(allocated.toString(), t.decimals),
    unallocated: toHuman((bal - allocated).toString(), t.decimals),
    payouts,
  };
}

// Release every due, unreleased, non-cancelled payout. Batches ERC-20 payrolls.
async function releaseDue(addr, meta) {
  const t = metaToken(meta);
  const w = operator();
  const c = new ethers.Contract(addr, ABI, w);
  const now = Math.floor(Date.now() / 1000);
  const count = Number(await c.payoutCount());

  const due = [];
  for (let id = 0; id < count; id++) {
    const p = await c.getPayout(id);
    if (!p[3] && !p[4] && Number(p[2]) <= now) due.push(id);
  }
  if (!due.length) return [];

  // Try the batch first (one tx for the whole cycle). If it reverts — e.g. a single
  // recipient is frozen/blacklisted by the token, which reverts the ENTIRE batch —
  // fall back to per-payout releases so one bad recipient can't stall everyone else.
  if (t.erc20 && due.length > 1) {
    try {
      const tx = await c.releaseBatch(due);
      await tx.wait();
      return due;
    } catch (e) {
      // fall through to individual releases below
    }
  }
  const released = [];
  for (const id of due) {
    try { const tx = await c.release(id); await tx.wait(); released.push(id); } catch (e) {}
  }
  return released;
}

module.exports = { RPC, EXPLORER, CHAIN, ABI, provider, operator, operatorAddress, readRoles, readPayroll, releaseDue };
