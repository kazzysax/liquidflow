// Circle CCTP V2 — canonical mainnet USDC across Ethereum, Polygon and Base.
//
// CCTP burns canonical USDC on the source chain and mints native USDC 1:1 on the
// destination. No liquidity pools, no third-party filler holding funds — which keeps
// this NON-CUSTODIAL. Liquid Flow never takes custody:
//   * the payer/merchant signs the burn on the source chain (we only hand them the
//     transaction to sign — the `quote` endpoint);
//   * Circle's attestation service signs off (we only read it — the `status` endpoint);
//   * the mint on the destination goes ONLY to the `mintRecipient` chosen at burn time,
//     so even when LF relays the final mint it cannot redirect the funds.
//
// Addresses/domains are Circle's published CCTP V2 mainnet values. USDC uses six
// decimals on all three allowlisted chains. Changes require re-verification upstream.
const { ethers } = require('ethers');
const { rpcUrl, isValidBaseAmount } = require('./chain');

// Same deterministic contract addresses on the three supported CCTP V2 mainnets.
const TOKEN_MESSENGER     = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'; // TokenMessengerV2
const MESSAGE_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'; // MessageTransmitterV2

// chainId -> { CCTP domain, USDC ERC-20 (6dp), display name }
const CHAINS = {
  'eip155:1':    { name: 'Ethereum',   domain: 0, usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  'eip155:8453': { name: 'Base',       domain: 6, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  'eip155:137':  { name: 'Polygon PoS',domain: 7, usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
};
const USDC_DECIMALS = 6;
const ZERO_BYTES32  = '0x' + '00'.repeat(32);

const ATTESTATION_API = process.env.CIRCLE_ATTESTATION_API || 'https://iris-api.circle.com';

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
  const domains = new Set(Object.values(CHAINS).map(c => c.domain));
  if (!domains.has(Number(sourceDomain))) throw new Error('unsupported source CCTP domain');
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
  if (message.length > 20002 || attestation.length > 4002) {
    throw new Error('message or attestation exceeds safe size limit');
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
