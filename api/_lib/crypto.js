// secp256k1 stealth address math.
// Ported from liquidflow-backend/payments/stealth_payment_demo.js
const nodeCrypto = require('crypto');
const { keccak_256 } = require('@noble/hashes/sha3');

const p = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');
const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const Gx = BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798');
const Gy = BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8');

function mod(a, m) { return ((a % m) + m) % m; }
function invn(a, m) {
  let [or, r] = [mod(a, m), m], [os, s] = [1n, 0n];
  while (r) { const q = or / r; [or, r] = [r, or - q * r]; [os, s] = [s, os - q * s]; }
  return mod(os, m);
}
function addPt(P, Q) {
  if (!P) return Q; if (!Q) return P;
  if (P.x === Q.x && mod(P.y + Q.y, p) === 0n) return null;
  let m;
  if (P.x === Q.x && P.y === Q.y) m = mod((3n * P.x * P.x) * invn(2n * P.y, p), p);
  else m = mod((Q.y - P.y) * invn(mod(Q.x - P.x, p), p), p);
  const x = mod(m * m - P.x - Q.x, p);
  return { x, y: mod(m * (P.x - x) - P.y, p) };
}
function mulPt(k, P) {
  k = mod(k, n); let R = null, A = P;
  while (k > 0n) { if (k & 1n) R = addPt(R, A); A = addPt(A, A); k >>= 1n; }
  return R;
}
const G = { x: Gx, y: Gy };

function randScalar() {
  return mod(BigInt('0x' + nodeCrypto.randomBytes(32).toString('hex')), n) || 1n;
}
function ptHex(P) {
  return P.x.toString(16).padStart(64, '0') + P.y.toString(16).padStart(64, '0');
}
function hexToPt(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{128}$/.test(hex)) throw new Error('invalid curve point hex');
  const x = BigInt('0x' + hex.slice(0, 64));
  const y = BigInt('0x' + hex.slice(64));
  // Defense-in-depth: reject anything not actually on secp256k1 (y^2 = x^3 + 7 mod p)
  // and reject the point at infinity. Guards against invalid-curve attacks if a
  // point ever arrives from an untrusted source.
  if (x <= 0n || x >= p || y <= 0n || y >= p) throw new Error('curve point out of field');
  if (mod(y * y, p) !== mod(x * x * x + 7n, p)) throw new Error('point not on curve');
  return { x, y };
}
function hashToScalar(buf) {
  return mod(BigInt('0x' + nodeCrypto.createHash('sha256').update(buf).digest('hex')), n);
}
function pointToAddress(P) {
  // Real EVM address = last 20 bytes of keccak256(uncompressed pubkey X||Y, 64 bytes).
  // This MUST be keccak256 (not sha256) so the stealth private key k_spend+s actually
  // controls the address on-chain — otherwise deposited funds are unspendable.
  const pub = Buffer.from(ptHex(P), 'hex');
  return '0x' + Buffer.from(keccak_256(pub)).subarray(12).toString('hex');
}

// Generate a fresh merchant keypair. k_spend is returned to merchant (never stored by LF).
// k_view + metaAddress are stored by LF for deposit recognition.
function generateKeypair() {
  const k_spend = randScalar();
  const k_view  = randScalar();
  return {
    k_spend:  k_spend.toString(16).padStart(64, '0'),
    k_view:   k_view.toString(16).padStart(64, '0'),
    P_spend:  ptHex(mulPt(k_spend, G)),
    P_view:   ptHex(mulPt(k_view,  G)),
  };
}

// Derive a fresh, unlinkable deposit address. Uses ONLY public keys — non-custodial.
function deriveDepositAddress(P_spend_hex, P_view_hex, paymentId) {
  const P_spend = hexToPt(P_spend_hex);
  const P_view  = hexToPt(P_view_hex);
  const r = randScalar();
  const R = mulPt(r, G);
  const shared = mulPt(r, P_view);
  const s = hashToScalar(Buffer.concat([
    Buffer.from(ptHex(shared), 'hex'),
    Buffer.from(paymentId, 'utf8'),
  ]));
  const P_stealth = addPt(P_spend, mulPt(s, G));
  return {
    depositAddress: pointToAddress(P_stealth),
    R: ptHex(R),
  };
}

// Recognize a deposit: LF uses the stored k_view to verify a deposit address.
function recognizeDeposit(P_spend_hex, k_view_hex, R_hex, paymentId) {
  const P_spend = hexToPt(P_spend_hex);
  const k_view  = BigInt('0x' + k_view_hex);
  const R       = hexToPt(R_hex);
  const shared  = mulPt(k_view, R);
  const s = hashToScalar(Buffer.concat([
    Buffer.from(ptHex(shared), 'hex'),
    Buffer.from(paymentId, 'utf8'),
  ]));
  const P_stealth = addPt(P_spend, mulPt(s, G));
  return pointToAddress(P_stealth);
}

// Derive the ONE-TIME PRIVATE KEY that controls a stealth deposit, from the
// recipient's own secret keys plus the payment's ephemeral pubkey R. This is the
// spend path: p_one = k_spend + s (mod n), where s = H(k_view·R || paymentId).
//
// SECURITY: this reconstructs a fund-moving key. It is intended to run ONLY on the
// merchant's own machine inside the offline sweep tool — never server-side, never
// logged, never transmitted. Liquid Flow does not hold k_spend, so the server
// cannot call this; that is the non-custodial guarantee.
function deriveStealthPrivKey(k_spend_hex, k_view_hex, R_hex, paymentId) {
  const k_spend = BigInt('0x' + k_spend_hex);
  const k_view  = BigInt('0x' + k_view_hex);
  const R       = hexToPt(R_hex);
  const shared  = mulPt(k_view, R);
  const s = hashToScalar(Buffer.concat([
    Buffer.from(ptHex(shared), 'hex'),
    Buffer.from(paymentId, 'utf8'),
  ]));
  const priv = mod(k_spend + s, n);
  if (priv === 0n) throw new Error('degenerate stealth key');
  return priv.toString(16).padStart(64, '0');
}

module.exports = { generateKeypair, deriveDepositAddress, recognizeDeposit, deriveStealthPrivKey };
