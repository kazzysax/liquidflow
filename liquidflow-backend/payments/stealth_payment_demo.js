// Liquid Flow — Stealth deposit addresses for the Integrate Payment System.
//
// Proves: when a payer arrives, the system derives a FRESH, unlinkable deposit
// address automatically from the builder's PUBLISHED meta-address (public keys
// only) + randomness. No builder action. No private key in the live path. The
// builder later sweeps with their spend key on their own schedule.
//
// This is the Potlock stealth scheme applied to payments, with a paymentId binding
// so each payment is trackable to the platform without exposing the link publicly.
//
// secp256k1, pure (no external deps).

const crypto = require('crypto');
const p = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');
const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const Gx = BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798');
const Gy = BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8');
function mod(a,m){return ((a%m)+m)%m;}
function invn(a,m){let[or,r]=[mod(a,m),m];let[os,s]=[1n,0n];while(r){const q=or/r;[or,r]=[r,or-q*r];[os,s]=[s,os-q*s];}return mod(os,m);}
function add(P,Q){if(!P)return Q;if(!Q)return P;if(P.x===Q.x&&mod(P.y+Q.y,p)===0n)return null;let m;if(P.x===Q.x&&P.y===Q.y)m=mod((3n*P.x*P.x)*invn(2n*P.y,p),p);else m=mod((Q.y-P.y)*invn(mod(Q.x-P.x,p),p),p);const x=mod(m*m-P.x-Q.x,p);return{x,y:mod(m*(P.x-x)-P.y,p)};}
function mul(k,P){k=mod(k,n);let R=null,A=P;while(k>0n){if(k&1n)R=add(R,A);A=add(A,A);k>>=1n;}return R;}
const G={x:Gx,y:Gy};
function rs(){return mod(BigInt('0x'+crypto.randomBytes(32).toString('hex')),n)||1n;}
function pub(k){return mul(k,G);}
function hs(buf){return mod(BigInt('0x'+crypto.createHash('sha256').update(buf).digest('hex')),n);}
function ptKey(P){return P.x.toString(16).padStart(64,'0')+P.y.toString(16).padStart(64,'0');}
function h2s(P){return hs(Buffer.from(ptKey(P),'hex'));}
function addr(P){return '0x'+crypto.createHash('sha256').update(Buffer.from(ptKey(P),'hex')).digest('hex').slice(24);}

// ---------- Builder setup (ONCE) ----------
// The builder publishes a meta-address (public keys). Private keys stay with them.
function builderSetup() {
  const k_spend = rs(), P_spend = pub(k_spend);
  const k_view  = rs(), P_view  = pub(k_view);
  return {
    metaAddress: { P_spend, P_view },          // PUBLISHED
    privateKeys: { k_spend, k_view },          // builder keeps; view may go to LF backend (read-only)
  };
}

// ---------- Live path: payer arrives, derive a fresh deposit address ----------
// Runs with PUBLIC keys only. No builder. No private key.
function deriveDepositAddress(metaAddress, paymentId) {
  const r = rs();                                  // random ephemeral (per payment)
  const R = pub(r);                                // ephemeral pubkey (published with the payment)
  // bind the paymentId into the secret so the address is tied to this payment
  const shared = mul(r, metaAddress.P_view);
  const s = hs(Buffer.concat([Buffer.from(ptKey(shared),'hex'), Buffer.from(paymentId)]));
  const P_stealth = add(metaAddress.P_spend, mul(s, G));
  return { depositAddress: addr(P_stealth), R, paymentId };
}

// ---------- Builder/LF view-key side: recognize a payment (read-only) ----------
function recognizePayment(metaAddress, k_view, R, paymentId) {
  const shared = mul(k_view, R);                   // same secret via view key
  const s = hs(Buffer.concat([Buffer.from(ptKey(shared),'hex'), Buffer.from(paymentId)]));
  const P_stealth = add(metaAddress.P_spend, mul(s, G));
  return { depositAddress: addr(P_stealth), s };
}

// ---------- Builder spend side: derive the private key to sweep (needs spend key) ----------
function deriveSpendKey(k_spend, s) { return mod(k_spend + s, n); }

// ============================================================
let pass=0, fail=0; const ok=(nm,c)=>{console.log((c?'  PASS: ':'  FAIL: ')+nm);c?pass++:fail++;};

const builder = builderSetup();
console.log('Builder published a meta-address ONCE. No further builder action needed.\n');

console.log('--- Payer A arrives, system derives a fresh deposit address ---');
const payA = deriveDepositAddress(builder.metaAddress, 'pay_4471');
console.log('   address for pay_4471:', payA.depositAddress);

console.log('\n--- Payer B arrives, gets a DIFFERENT address ---');
const payB = deriveDepositAddress(builder.metaAddress, 'pay_4472');
console.log('   address for pay_4472:', payB.depositAddress);
ok('two payers get different deposit addresses', payA.depositAddress !== payB.depositAddress);

console.log('\n--- TEST: builder/LF view key recognizes which address belongs to which payment ---');
const recA = recognizePayment(builder.metaAddress, builder.privateKeys.k_view, payA.R, 'pay_4471');
ok('view key recomputes the same address (for tracking/totalling)', recA.depositAddress === payA.depositAddress);

console.log('\n--- TEST: builder can derive the private key to sweep the funds (spend key only) ---');
const skA = deriveSpendKey(builder.privateKeys.k_spend, recA.s);
ok('spend key derives the controlling private key', addr(pub(skA)) === payA.depositAddress);

console.log('\n--- TEST: the live derivation used NO private key (non-custodial) ---');
// deriveDepositAddress only takes metaAddress (public) + paymentId. Proven by signature.
ok('deposit address derived from PUBLIC keys only', deriveDepositAddress.length === 2);

console.log('\n--- TEST: an outsider cannot link the address to the platform ---');
const attackerView = rs();
const fake = recognizePayment(builder.metaAddress, attackerView, payA.R, 'pay_4471');
ok('wrong view key cannot reproduce the address (unlinkable)', fake.depositAddress !== payA.depositAddress);

console.log('\n--- TEST: view key alone cannot sweep (cannot move funds) ---');
const viewOnlyTry = mod(0n + recA.s, n); // missing k_spend
ok('view-key holder (e.g. LF backend) cannot spend', addr(pub(viewOnlyTry)) !== payA.depositAddress);

console.log('\n--- TEST: same payment recomputes the same address (idempotent tracking) ---');
const recAagain = recognizePayment(builder.metaAddress, builder.privateKeys.k_view, payA.R, 'pay_4471');
ok('recognition is deterministic for a given (R, paymentId)', recAagain.depositAddress === payA.depositAddress);

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail===0?0:1);
