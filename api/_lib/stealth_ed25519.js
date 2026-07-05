// ⚠️ UNAUDITED — TESTNET ONLY.
// Non-custodial dual-key stealth addresses over ed25519, for Solana & Sui.
// Mirrors the secp256k1 scheme in crypto.js (EIP-5564 / Monero-style):
//   recipient publishes meta keys (P_spend, P_view); the spend key k_spend is
//   returned to them ONCE and never stored server-side. A one-time deposit
//   address is derived per payment; only k_spend can move the funds.
//
//   shared secret  s = H(r·P_view) = H(k_view·R)
//   one-time point P_one = P_spend + s·G
//
// This is the project's highest-risk cryptographic component. It MUST pass a
// dedicated cryptographic audit (GO-LIVE Phase 5) before any mainnet use.
// Uses @noble/curves v1 (CommonJS-compatible — required by the Vercel functions runtime).
const crypto  = require('crypto');
const ed      = require('@noble/curves/ed25519');
const { sha512 }  = require('@noble/hashes/sha512');
const { blake2b } = require('@noble/hashes/blake2b');
const { base58 }  = require('@scure/base');

const Point = ed.ed25519.ExtendedPoint || ed.ExtendedPoint; // Edwards point class
const G = Point.BASE;
const L = ed.ed25519.CURVE.n;         // group order

const bytesToBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const mod = (a) => { const r = a % L; return r >= 0n ? r : r + L; };
function randScalar() { const s = mod(bytesToBig(crypto.randomBytes(32))); return s === 0n ? 1n : s; }
const toHex = (b) => Buffer.from(b).toString('hex');

// Recipient meta-keypair. k_spend is the sweep key (return once, never store).
function generateKeypair() {
  const k_spend = randScalar();
  const k_view  = randScalar();
  return {
    k_spend: k_spend.toString(16).padStart(64, '0'),
    k_view:  k_view.toString(16).padStart(64, '0'),
    P_spend: toHex(G.multiply(k_spend).toRawBytes()),
    P_view:  toHex(G.multiply(k_view).toRawBytes()),
  };
}

// One-time stealth public key for a payment. Returns the 32-byte point + R (ephemeral pub).
function deriveStealthPoint(P_spend_hex, P_view_hex) {
  const Pspend = Point.fromHex(P_spend_hex);
  const Pview  = Point.fromHex(P_view_hex);
  const r = randScalar();
  const R = G.multiply(r).toRawBytes();          // ephemeral public key (stored server-side)
  let s = mod(bytesToBig(sha512(Pview.multiply(r).toRawBytes())));
  if (s === 0n) s = 1n;
  const Pone = Pspend.add(G.multiply(s));        // P_spend + s·G
  return { point: Pone.toRawBytes(), R: toHex(R) };
}

// Solana deposit address = base58 of the 32-byte ed25519 public key.
function solanaAddress(P_spend, P_view) {
  const { point, R } = deriveStealthPoint(P_spend, P_view);
  return { depositAddress: base58.encode(point), R };
}

// Sui deposit address = 0x + blake2b-256( 0x00 (ed25519 flag) || pubkey ).
function suiAddress(P_spend, P_view) {
  const { point, R } = deriveStealthPoint(P_spend, P_view);
  const flagged = new Uint8Array(point.length + 1);
  flagged[0] = 0x00;
  flagged.set(point, 1);
  return { depositAddress: '0x' + toHex(blake2b(flagged, { dkLen: 32 })), R };
}

module.exports = { generateKeypair, deriveStealthPoint, solanaAddress, suiAddress };
