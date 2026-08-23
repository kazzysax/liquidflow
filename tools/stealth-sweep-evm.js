#!/usr/bin/env node
/**
 * Offline EVM stealth sweep tool — Liquid Flow (non-custodial).
 *
 * Reconstructs the one-time private key for a confirmed stealth deposit and sweeps
 * the funds to an address you choose. Runs ENTIRELY on your machine: your secret
 * keys are read from environment variables and never printed, logged, or sent
 * anywhere. Liquid Flow never holds k_spend, so only you can run this.
 *
 * ── Inputs ────────────────────────────────────────────────────────────────────
 *   Secrets (env, so they don't leak into your shell's process list):
 *     LF_K_SPEND   your merchant spend key (64-hex, from signup — never shown again)
 *     LF_K_VIEW    your merchant view key  (64-hex, from signup)
 *     LF_RPC       an RPC URL for the target chain (required; use your own for mainnet)
 *
 *   What to sweep (one of):
 *     --file recovery.json   the JSON from GET /api/payments/recover
 *     --payment <id> --R <hex> --chain <eip155:...> --deposit <0x...> --amount <base>
 *
 *   Where funds go:
 *     --to 0xYourWallet      destination for swept funds (required)
 *
 *   Safety:
 *     (default)              DRY RUN — derive, verify, and print the plan only
 *     --confirm              actually broadcast the sweep transaction(s)
 *
 * ── Examples ──────────────────────────────────────────────────────────────────
 *   LF_K_SPEND=... LF_K_VIEW=... LF_RPC=https://sepolia.base.org \
 *     node tools/stealth-sweep-evm.js --file recovery.json --to 0xMyWallet
 *   (add --confirm to send)
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { deriveStealthPrivKey } = require(path.join(__dirname, '..', 'api', '_lib', 'crypto'));
const { assetConfig } = require(path.join(__dirname, '..', 'api', '_lib', 'chain'));

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true; // bare flag → true
}
function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

const K_SPEND = process.env.LF_K_SPEND;
const K_VIEW  = process.env.LF_K_VIEW;
const RPC     = process.env.LF_RPC;
const TO      = arg('to');
const CONFIRM = arg('confirm') === true;

if (!K_SPEND || !K_VIEW) die('set LF_K_SPEND and LF_K_VIEW in the environment');
if (!/^[0-9a-fA-F]{64}$/.test(K_SPEND) || !/^[0-9a-fA-F]{64}$/.test(K_VIEW)) die('LF_K_SPEND / LF_K_VIEW must be 64-hex');
if (!RPC) die('set LF_RPC to an RPC URL for the target chain');
if (!TO || !/^0x[0-9a-fA-F]{40}$/.test(TO)) die('--to must be a valid 0x address');

// Build the work list from either --file or single-payment flags.
let entries = [];
const file = arg('file');
if (file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  entries = Array.isArray(parsed) ? parsed : (parsed.payments || []);
} else if (arg('payment')) {
  entries = [{
    payment_id: arg('payment'),
    R: arg('R'),
    chain: arg('chain'),
    deposit_address: arg('deposit'),
    amount: arg('amount'),
  }];
} else {
  die('provide --file recovery.json OR --payment <id> --R <hex> --chain <eip155:...>');
}

const isEvm = (c) => typeof c === 'string' && c.startsWith('eip155:');

async function sweepOne(provider, e) {
  if (!isEvm(e.chain)) {
    console.log(`- ${e.payment_id}: SKIP (${e.chain} is not EVM; ed25519 sweep is not supported by this tool)`);
    return;
  }
  if (!e.R || !/^[0-9a-fA-F]{128}$/.test(e.R)) { console.log(`- ${e.payment_id}: SKIP (missing/!128-hex R)`); return; }

  const priv   = deriveStealthPrivKey(K_SPEND, K_VIEW, e.R, e.payment_id);
  const wallet = new ethers.Wallet('0x' + priv, provider);
  const addr   = wallet.address;

  // Verify the reconstructed key controls the address the server told us funded.
  if (e.deposit_address && addr.toLowerCase() !== String(e.deposit_address).toLowerCase()) {
    console.log(`- ${e.payment_id}: ABORT (derived ${addr} != deposit ${e.deposit_address}; wrong keys or wrong R)`);
    return;
  }

  // Mainnet VERSE/USDC sweep. Never trust a token address supplied by a recovery
  // file: recompute the canonical contract from LiquidFlow's hardcoded allowlist.
  const cfg = assetConfig(e.chain, e.asset || e.symbol);
  if (e.token_contract || cfg) {
    if (!cfg || !e.token_contract || cfg.contract.toLowerCase() !== String(e.token_contract).toLowerCase()) {
      console.log(`- ${e.payment_id}: ABORT (token contract is not canonical for ${e.chain})`);
      return;
    }
    const token = new ethers.Contract(cfg.contract, [
      'function balanceOf(address) view returns (uint256)',
      'function transfer(address,uint256) returns (bool)',
    ], wallet);
    const tokenBalance = await token.balanceOf(addr);
    if (tokenBalance === 0n) { console.log(`- ${e.payment_id}: ${cfg.symbol} balance 0 — nothing to sweep`); return; }

    const txBase = await token.transfer.populateTransaction(TO, tokenBalance);
    const gasLimit = await provider.estimateGas({ ...txBase, from: addr });
    const fee = await provider.getFeeData();
    const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
    if (!gasPrice) { console.log(`- ${e.payment_id}: SKIP (no gas price from RPC)`); return; }
    const gasNeeded = gasLimit * gasPrice;
    const nativeBalance = await provider.getBalance(addr);
    if (nativeBalance < gasNeeded) {
      console.log(`- ${e.payment_id}: NEED GAS ${gasNeeded - nativeBalance} native base units at ${addr} before sweeping ${ethers.formatUnits(tokenBalance, cfg.decimals)} ${cfg.symbol}`);
      return;
    }
    const plan = `${ethers.formatUnits(tokenBalance, cfg.decimals)} ${cfg.symbol} from ${addr} → ${TO}`;
    if (!CONFIRM) { console.log(`- ${e.payment_id}: DRY RUN would sweep ${plan}; estimated gas ${gasNeeded}`); return; }
    const txReq = fee.maxFeePerGas
      ? { ...txBase, gasLimit, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { ...txBase, gasLimit, gasPrice };
    const tx = await wallet.sendTransaction(txReq);
    console.log(`- ${e.payment_id}: SENT ${plan}  tx=${tx.hash}`);
    await tx.wait();
    console.log(`  confirmed ${tx.hash}`);
    return;
  }

  const balance = await provider.getBalance(addr);
  if (balance === 0n) { console.log(`- ${e.payment_id}: ${addr} balance 0 — nothing to sweep`); return; }

  // Native sweep: send (balance - gas) to the destination.
  const fee      = await provider.getFeeData();
  const gasLimit = 21000n;
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
  if (!gasPrice) { console.log(`- ${e.payment_id}: SKIP (no gas price from RPC)`); return; }
  const cost  = gasLimit * gasPrice;
  const value = balance - cost;
  if (value <= 0n) { console.log(`- ${e.payment_id}: ${addr} balance ${balance} < gas ${cost} — dust, skipping`); return; }

  const plan = `${ethers.formatEther(value)} (of ${ethers.formatEther(balance)}) from ${addr} → ${TO}`;
  if (!CONFIRM) { console.log(`- ${e.payment_id}: DRY RUN would sweep ${plan}`); return; }

  const txReq = fee.maxFeePerGas
    ? { to: TO, value, gasLimit, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
    : { to: TO, value, gasLimit, gasPrice };
  const tx = await wallet.sendTransaction(txReq);
  console.log(`- ${e.payment_id}: SENT ${plan}  tx=${tx.hash}`);
  await tx.wait();
  console.log(`  confirmed ${tx.hash}`);
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  console.log(`${CONFIRM ? 'SWEEP' : 'DRY RUN'} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} → ${TO}`);
  for (const e of entries) {
    try { await sweepOne(provider, e); }
    catch (err) { console.log(`- ${e.payment_id || '?'}: ERROR ${err.message}`); }
  }
  if (!CONFIRM) console.log('\nDry run only. Re-run with --confirm to broadcast.');
})();
