// Liquid Flow — Receipt anti-forgery proof of concept (runnable).
//
// Demonstrates the two-source-of-truth receipt model:
//   1. The receipt references a real on-chain tx (explorer link included).
//   2. The receipt is signed by Liquid Flow's key (Ed25519).
// A receipt is valid ONLY IF the signature verifies AND (in production) the
// on-chain tx matches. This script proves: a tampered receipt fails verification,
// and a forged receipt without the private key cannot be produced.
//
// Uses Node's built-in crypto (Ed25519) — no external deps — so it runs anywhere.

const crypto = require('crypto');

// ---- Liquid Flow's receipt-signing keypair (server-side; signs receipts only,
//      NEVER moves funds — non-custodial is unaffected) ----
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

// ---- explorer URL templates per chain ----
const EXPLORERS = {
  'eip155:1':     tx => `https://etherscan.io/tx/${tx}`,
  'eip155:8453':  tx => `https://basescan.org/tx/${tx}`,
  'eip155:137':   tx => `https://polygonscan.com/tx/${tx}`,
  'solana':       tx => `https://solscan.io/tx/${tx}`,
  'aptos':        tx => `https://explorer.aptoslabs.com/txn/${tx}`,
  'sui':          tx => `https://suiscan.xyz/tx/${tx}`,
  'near':         tx => `https://nearblocks.io/txns/${tx}`,
};

function explorerLink(chainId, txHash) {
  const f = EXPLORERS[chainId];
  return f ? f(txHash) : null;
}

// ---- canonical serialization: stable key order so the signed bytes are
//      deterministic (a forger can't exploit key reordering) ----
function canonical(receipt) {
  const ordered = {
    receipt_id: receipt.receipt_id,
    payment_id: receipt.payment_id,
    platform_id: receipt.platform_id,
    chain_id: receipt.chain_id,
    tx_hash: receipt.tx_hash,
    asset: receipt.asset,
    amount_base_units: receipt.amount_base_units,
    payer_ref: receipt.payer_ref,
    merchant_address: receipt.merchant_address,
    confirmed_at: receipt.confirmed_at,
    confirmations: receipt.confirmations,
    final: receipt.final,
  };
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

// ---- issue a signed receipt ----
function issueReceipt(data) {
  const receipt = {
    ...data,
    explorer_url: explorerLink(data.chain_id, data.tx_hash),
  };
  const sig = crypto.sign(null, canonical(receipt), privateKey);
  receipt.signature = sig.toString('base64');
  receipt.signer_pubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return receipt;
}

// ---- verify a receipt's signature (anyone can do this with the public key) ----
function verifyReceipt(receipt, trustedPubkeyDerB64) {
  // In production the verifier pins Liquid Flow's known public key rather than
  // trusting the one embedded in the receipt. We pass it explicitly here.
  const pub = crypto.createPublicKey({
    key: Buffer.from(trustedPubkeyDerB64, 'base64'),
    type: 'spki', format: 'der',
  });
  const sig = Buffer.from(receipt.signature, 'base64');
  return crypto.verify(null, canonical(receipt), pub, sig);
}

// =====================================================================
// PROOF RUNS
// =====================================================================
const trustedPub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? '  PASS: ' : '  FAIL: ') + n); c ? pass++ : fail++; };

// A genuine payment receipt
const genuine = issueReceipt({
  receipt_id: 'rcpt_01HXY...',
  payment_id: 'pay_4471',
  platform_id: 'platform_abc',
  chain_id: 'eip155:8453',
  tx_hash: '0x9f4c3a2b1e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4d',
  asset: 'USDC',
  amount_base_units: '50000000', // 50 USDC (6 decimals)
  payer_ref: 'anon',
  merchant_address: '0xMerchantHardcodedAddress00000000000000000',
  confirmed_at: '2026-01-15T10:32:00Z',
  confirmations: 12,
  final: true,
});

console.log('--- A genuine signed receipt ---');
console.log('  explorer_url:', genuine.explorer_url);
console.log('');

console.log('--- TEST 1: genuine receipt verifies ---');
ok('genuine receipt passes signature verification', verifyReceipt(genuine, trustedPub));

console.log('\n--- TEST 2: tampering with the amount breaks verification ---');
const tamperedAmount = JSON.parse(JSON.stringify(genuine));
tamperedAmount.amount_base_units = '500000000'; // forger inflates 50 -> 500 USDC
ok('tampered amount fails verification', !verifyReceipt(tamperedAmount, trustedPub));

console.log('\n--- TEST 3: tampering with the tx hash breaks verification ---');
const tamperedTx = JSON.parse(JSON.stringify(genuine));
tamperedTx.tx_hash = '0xdeadbeef' + genuine.tx_hash.slice(10);
ok('tampered tx_hash fails verification', !verifyReceipt(tamperedTx, trustedPub));

console.log('\n--- TEST 4: tampering with the merchant address breaks verification ---');
const tamperedDest = JSON.parse(JSON.stringify(genuine));
tamperedDest.merchant_address = '0xAttackerAddress1111111111111111111111111111';
ok('tampered merchant address fails verification', !verifyReceipt(tamperedDest, trustedPub));

console.log('\n--- TEST 5: a forger WITHOUT the private key cannot mint a valid receipt ---');
const forgerKeys = crypto.generateKeyPairSync('ed25519');
const forged = JSON.parse(JSON.stringify(genuine));
forged.amount_base_units = '999000000';
// forger signs with THEIR key
forged.signature = crypto.sign(null, canonical(forged), forgerKeys.privateKey).toString('base64');
ok('forged receipt (wrong signing key) fails verification', !verifyReceipt(forged, trustedPub));

console.log('\n--- TEST 6: re-ordering JSON keys does not change the verdict (canonical form) ---');
const reordered = {};
Object.keys(genuine).reverse().forEach(k => { reordered[k] = genuine[k]; });
ok('key-reordered genuine receipt still verifies', verifyReceipt(reordered, trustedPub));

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
