// Liquid Flow — Stealth address proof of concept (runnable, secp256k1).
//
// Proves the dual-key stealth scheme that makes Potlock donations unlinkable:
//   * Campaign has (spend, view) keypairs and publishes a stealth meta-address.
//   * A donor derives a UNIQUE one-time stealth address per donation from the
//     meta-address + a random ephemeral key. Sends funds there, publishes R.
//   * The campaign, using its VIEW key, recognizes which addresses are its
//     donations; using its SPEND key, can compute the private key to move them.
//   * The VIEW key can find/total donations but CANNOT spend (non-custodial).
//   * An outsider (no view key) cannot link a stealth address to the campaign or
//     link two donations together.
//
// Uses Node's secp256k1 via elliptic-style math on the built-in crypto ECDH where
// possible, plus a tiny scalar/point layer. Pure, no external deps.

const crypto = require('crypto');

// ---- secp256k1 parameters ----
const p = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');
const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const Gx = BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798');
const Gy = BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8');

function mod(a, m) { return ((a % m) + m) % m; }
function inv(a, m) { // modular inverse via extended Euclid
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
  return mod(old_s, m);
}
// point ops on secp256k1 (affine, null = infinity)
function ptAdd(P, Q) {
  if (!P) return Q; if (!Q) return P;
  if (P.x === Q.x && mod(P.y + Q.y, p) === 0n) return null;
  let m;
  if (P.x === Q.x && P.y === Q.y) m = mod((3n * P.x * P.x) * inv(2n * P.y, p), p);
  else m = mod((Q.y - P.y) * inv(mod(Q.x - P.x, p), p), p);
  const x = mod(m * m - P.x - Q.x, p);
  const y = mod(m * (P.x - x) - P.y, p);
  return { x, y };
}
function ptMul(k, P) {
  k = mod(k, n); let R = null, A = P;
  while (k > 0n) { if (k & 1n) R = ptAdd(R, A); A = ptAdd(A, A); k >>= 1n; }
  return R;
}
const G = { x: Gx, y: Gy };
function randScalar() { return mod(BigInt('0x' + crypto.randomBytes(32).toString('hex')), n) || 1n; }
function pubFromPriv(k) { return ptMul(k, G); }
function hashPointToScalar(P) {
  const h = crypto.createHash('sha256').update(P.x.toString(16).padStart(64,'0') + P.y.toString(16).padStart(64,'0')).digest('hex');
  return mod(BigInt('0x' + h), n);
}
function addrOf(P) { // a stand-in "address" = hash of the pubkey (like a chain address)
  return crypto.createHash('sha256').update(P.x.toString(16).padStart(64,'0') + P.y.toString(16).padStart(64,'0')).digest('hex').slice(24);
}

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? '  PASS: ' : '  FAIL: ') + n); c ? pass++ : fail++; };

// ============================================================
// Campaign keys
const k_spend = randScalar(), P_spend = pubFromPriv(k_spend);
const k_view  = randScalar(), P_view  = pubFromPriv(k_view);
console.log('Campaign meta-address published: (P_spend, P_view)\n');

// Donor makes a donation
function donate() {
  const r = randScalar();             // ephemeral private
  const R = pubFromPriv(r);           // ephemeral public (published)
  const s = hashPointToScalar(ptMul(r, P_view));  // shared secret = hash(r·P_view)
  const P_stealth = ptAdd(P_spend, ptMul(s, G));  // one-time address pubkey
  return { R, stealthAddr: addrOf(P_stealth), P_stealth };
}

// Campaign scans an announcement R to see if it's theirs + recover spend key
function recognize(R) {
  const s = hashPointToScalar(ptMul(k_view, R));  // same secret via view key
  const P_stealth = ptAdd(P_spend, ptMul(s, G));
  const k_stealth = mod(k_spend + s, n);          // private key (needs SPEND key)
  return { stealthAddr: addrOf(P_stealth), k_stealth, P_stealth };
}

console.log('--- TEST 1: campaign recognizes its own donation ---');
const d1 = donate();
const r1 = recognize(d1.R);
ok('view key recomputes the same stealth address', d1.stealthAddr === r1.stealthAddr);

console.log('\n--- TEST 2: recovered private key controls the stealth address ---');
ok('spend key derives the matching private key', addrOf(pubFromPriv(r1.k_stealth)) === d1.stealthAddr);

console.log('\n--- TEST 3: each donation yields a DIFFERENT unlinkable address ---');
const d2 = donate(), d3 = donate();
ok('two donations -> two different stealth addresses', d1.stealthAddr !== d2.stealthAddr && d2.stealthAddr !== d3.stealthAddr);

console.log('\n--- TEST 4: an OUTSIDER (no view key) cannot recognize a donation ---');
const k_view_attacker = randScalar();
const sFake = hashPointToScalar(ptMul(k_view_attacker, d1.R));
const fakeAddr = addrOf(ptAdd(P_spend, ptMul(sFake, G)));
ok('wrong view key cannot derive the real stealth address', fakeAddr !== d1.stealthAddr);

console.log('\n--- TEST 5: VIEW key alone cannot spend (needs SPEND key) ---');
// With only k_view and R, the best an attacker can compute is s, but NOT k_spend.
// The stealth private key is (k_spend + s); without k_spend it is unknown.
const sOnly = hashPointToScalar(ptMul(k_view, d1.R));
// attacker tries to spend with just s (missing k_spend):
const attackerKey = mod(0n + sOnly, n); // no k_spend
ok('view-only key cannot reconstruct the spend key', addrOf(pubFromPriv(attackerKey)) !== d1.stealthAddr);

console.log('\n--- TEST 6: campaign totals N donations via view key (public total works) ---');
const donations = [d1, d2, d3];
let recognizedCount = 0;
for (const d of donations) { if (recognize(d.R).stealthAddr === d.stealthAddr) recognizedCount++; }
ok('campaign recognizes all 3 of its donations for totalling', recognizedCount === 3);

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
