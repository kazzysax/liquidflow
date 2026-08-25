const crypto = require('crypto');
const { assetConfig } = require('./chain');

const FIELDS = Object.freeze([
  'schema_version', 'receipt_id', 'payment_id', 'merchant_name', 'chain_id',
  'tx_hash', 'asset', 'token_contract', 'amount_base_units', 'decimals',
  'payer_address', 'deposit_address', 'confirmed_at', 'confirmations', 'final',
]);

function privateKey() {
  const encoded = String(process.env.RECEIPT_SIGNING_PRIVATE_KEY_B64 || '').trim();
  if (!encoded) throw new Error('receipt signing key is not configured');
  return crypto.createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
}

function publicKeyInfo() {
  const der = crypto.createPublicKey(privateKey()).export({ format: 'der', type: 'spki' });
  return {
    algorithm: 'Ed25519',
    public_key_spki_b64: der.toString('base64'),
    fingerprint_sha256: crypto.createHash('sha256').update(der).digest('hex'),
  };
}

function canonical(receipt) {
  const ordered = {};
  for (const field of FIELDS) ordered[field] = receipt[field];
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

function receiptFor(payment, merchantName = 'Merchant') {
  if (!payment || payment.status !== 'confirmed') throw new Error('payment is not confirmed');
  const hashes = [...new Set(payment.transactionHashes || [])];
  if (hashes.length !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(hashes[0])) {
    throw new Error('confirmed payment does not have one proven transaction hash');
  }
  const cfg = assetConfig(payment.chain, payment.asset);
  if (!cfg) throw new Error('payment asset is not supported');
  const confirmedAt = new Date(payment.confirmedAt).toISOString();
  const receiptId = 'rcpt_' + crypto.createHash('sha256')
    .update(`${payment.id}|${payment.confirmedAt}|${hashes[0].toLowerCase()}`)
    .digest('hex').slice(0, 24);
  return {
    schema_version: 1,
    receipt_id: receiptId,
    payment_id: payment.id,
    merchant_name: merchantName,
    chain_id: payment.chain,
    tx_hash: hashes[0].toLowerCase(),
    asset: cfg.symbol,
    token_contract: cfg.contract,
    amount_base_units: String(payment.amount),
    decimals: cfg.decimals,
    payer_address: payment.payerAddress || null,
    deposit_address: payment.depositAddress,
    confirmed_at: confirmedAt,
    confirmations: Number(payment.confirmations || 0),
    final: true,
  };
}

function issue(payment, merchantName) {
  const receipt = receiptFor(payment, merchantName);
  const signature = crypto.sign(null, canonical(receipt), privateKey());
  const key = publicKeyInfo();
  return {
    receipt,
    signature_b64: signature.toString('base64'),
    signer: key,
  };
}

function verify(bundle) {
  if (!bundle || !bundle.receipt || typeof bundle.signature_b64 !== 'string') return false;
  try {
    return crypto.verify(null, canonical(bundle.receipt), crypto.createPublicKey(privateKey()), Buffer.from(bundle.signature_b64, 'base64'));
  } catch {
    return false;
  }
}

module.exports = { FIELDS, canonical, publicKeyInfo, receiptFor, issue, verify };
