// Circle CCTP V2 — native cross-chain USDC for Arc (testnet).
//
// Arc is Circle's own chain (USDC is the gas token), so the canonical way to move
// value in and out is CCTP: USDC is BURNED on the source chain and MINTED 1:1 on the
// destination. No liquidity pools, no third-party filler holding funds — which keeps
// this NON-CUSTODIAL. Liquid Flow never takes custody:
//   * the payer/merchant signs the burn on the source chain (we only hand them the
//     transaction to sign — the `quote` endpoint);
//   * Circle's attestation service signs off (we only read it — the `status` endpoint);
//   * the mint on the destination goes ONLY to the `mintRecipient` chosen at burn time,
//     so even when LF relays the final mint it cannot redirect the funds.
//
// Addresses/domains are Circle's published CCTP V2 TESTNET values (verified against
// developers.circle.com). USDC's ERC-20 interface is 6 decimals on every chain here,
// including Arc's ERC-20 USDC at 0x3600…0000 (distinct from Arc's 18-dp *native* gas).
//
// ⚠️ Testnet only. Uses the sandbox attestation API. Do not point at mainnet without
// swapping the address book + attestation host and clearing the Phase-5 gate.
const { ethers } = require('ethers');
const { rpcUrl, isValidBaseAmount } = require('./chain');

// Same deterministic contract addresses on every CCTP V2 testnet chain.
const TOKEN_MESSENGER     = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'; // TokenMessengerV2
const MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'; // MessageTransmitterV2

// chainId -> { CCTP domain, USDC ERC-20 (6dp), display name }
const CHAINS = {
  'eip155:11155111': { name: 'Ethereum Sepolia', domain: 0,  usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  'eip155:84532':    { name: 'Base Sepolia',     domain: 6,  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  'eip155:5042002':  { name: 'Arc Testnet',      domain: 26, usdc: '0x3600000000000000000000000000000000000000' },
};
const USDC_DECIMALS = 6;
const ZERO_BYTES32  = '0x' + '00'.repeat(32);

const ATTESTATION_API = process.env.CIRCLE_ATTESTATION_API || 'https://iris-api-sandbox.circle.com';

// Standard (hard-finality) transfer: no fast-transfer fee, wait for finality.
const STANDARD_MAX_FEE            = 0n;
const STANDARD_FINALITY_THRESHOLD = 2000;

const iUSDC = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const iTM   = new ethers.Interface([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);
const iMT   = new ethers.Interface(['function receiveMessage(bytes message, bytes attestation) returns (bool)']);

const supported = (chain) => !!CHAINS[chain];
const chainList = () => Object.entries(CHAINS).map(([id, c]) => ({ chain: id, name: c.name, domain: c.domain }));

// Left-pad a 20-byte EVM address into the 32-byte form CCTP expects.
function addressToBytes32(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('invalid EVM address');
  return '0x' + '000000000000000000000000' + addr.slice(2).toLowerCase();
}

// Build the two transactions the user signs on the SOURCE chain to start a transfer:
// (1) approve the TokenMessenger to pull `amount` USDC, (2) depositForBurn. We return
// ready-to-sign calldata; we never sign or hold funds.
function buildBurnPlan({ from, to, amount, recipient }) {
  const src = CHAINS[from], dst = CHAINS[to];
  if (!src) throw new Error(`unsupported source chain ${from}`);
  if (!dst) throw new Error(`unsupported destination chain ${to}`);
  if (from === to) throw new Error('source and destination must differ');
  if (!isValidBaseAmount(amount)) throw new Error('amount must be a positive integer in USDC base units (6 dp)');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(recipient || ''))) throw new Error('recipient must be a valid 0x address');

  const amt = BigInt(amount);
  const mintRecipient = addressToBytes32(recipient);
  const burnData = iTM.encodeFunctionData('depositForBurn', [
    amt, dst.domain, mintRecipient, src.usdc,
    ZERO_BYTES32,                 // destinationCaller = anyone (permissionless mint)
    STANDARD_MAX_FEE, STANDARD_FINALITY_THRESHOLD,
  ]);
  const approveData = iUSDC.encodeFunctionData('approve', [TOKEN_MESSENGER, amt]);

  return {
    source: {
      chain: from, name: src.name, domain: src.domain, usdc: src.usdc,
      token_messenger: TOKEN_MESSENGER,
      steps: [
        { label: 'approve', to: src.usdc,        data: approveData, value: '0' },
        { label: 'burn',    to: TOKEN_MESSENGER, data: burnData,    value: '0' },
      ],
    },
    destination: { chain: to, name: dst.name, domain: dst.domain },
    amount: amount, amount_decimals: USDC_DECIMALS,
    recipient,
    note: 'Sign both source-chain steps in order (approve, then burn), then poll /api/swap/status with the burn tx hash and source domain to get the mint attestation.',
  };
}

// Poll Circle's attestation service for a burn tx. status === 'complete' => ready to mint.
async function getAttestation(sourceDomain, txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) throw new Error('invalid transaction hash');
  const url = `${ATTESTATION_API}/v2/messages/${Number(sourceDomain)}?transactionHash=${txHash}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return { status: 'pending_confirmations', message: null, attestation: null };
  if (!r.ok) throw new Error(`attestation API ${r.status}`);
  const j = await r.json();
  const m = j && j.messages && j.messages[0];
  if (!m) return { status: 'pending_confirmations', message: null, attestation: null };
  return {
    status:      m.status,                                   // 'complete' | 'pending_confirmations'
    message:     m.status === 'complete' ? m.message : null,
    attestation: m.status === 'complete' ? m.attestation : null,
    event_nonce: m.eventNonce || null,
  };
}

// OPTIONAL relay: submit the mint on the destination chain so the recipient doesn't need
// gas there. Non-custodial — receiveMessage mints only to the recipient fixed at burn
// time; the relayer just pays gas and cannot redirect funds.
async function relayMint({ to, message, attestation }) {
  const dst = CHAINS[to];
  if (!dst) throw new Error(`unsupported destination chain ${to}`);
  if (!/^0x[0-9a-fA-F]+$/.test(String(message || '')) || !/^0x[0-9a-fA-F]+$/.test(String(attestation || ''))) {
    throw new Error('message and attestation must be hex');
  }
  if (!process.env.LF_OPERATOR_KEY) throw new Error('LF_OPERATOR_KEY not set (needed to relay the mint)');
  const provider = new ethers.JsonRpcProvider(rpcUrl(to));
  const wallet   = new ethers.Wallet(process.env.LF_OPERATOR_KEY, provider);
  const mt       = new ethers.Contract(MESSAGE_TRANSMITTER, iMT.fragments, wallet);
  const tx       = await mt.receiveMessage(message, attestation);
  const receipt  = await tx.wait();
  return { tx_hash: tx.hash, status: receipt.status === 1 ? 'minted' : 'failed' };
}

module.exports = {
  CHAINS, TOKEN_MESSENGER, MESSAGE_TRANSMITTER, USDC_DECIMALS, ATTESTATION_API,
  supported, chainList, addressToBytes32, buildBurnPlan, getAttestation, relayMint,
};
