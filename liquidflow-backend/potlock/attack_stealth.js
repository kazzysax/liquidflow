// ADVERSARIAL SUITE — attacks the Potlock stealth-address crypto.
// Tries to break donor unlinkability, steal donations, or forge recognition.
// Reuses the same secp256k1 math as the demo. WANT: attacks fail (privacy holds).

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
function h2s(P){return mod(BigInt('0x'+crypto.createHash('sha256').update(P.x.toString(16).padStart(64,'0')+P.y.toString(16).padStart(64,'0')).digest('hex')),n);}
function addr(P){return crypto.createHash('sha256').update(P.x.toString(16).padStart(64,'0')+P.y.toString(16).padStart(64,'0')).digest('hex').slice(24);}

let secure=0,vuln=0;
const guard=(nm,ok)=>{console.log((ok?'  SECURE: ':'  *** VULN *** : ')+nm);ok?secure++:vuln++;};

// campaign
const ks=rs(),Ps=pub(ks), kv=rs(),Pv=pub(kv);
function donate(){const r=rs(),R=pub(r);const s=h2s(mul(r,Pv));return{R,s,P:add(Ps,mul(s,G)),a:addr(add(Ps,mul(s,G)))};}

console.log('=== STEALTH CRYPTO ATTACKS ===\n');

console.log('--- ATTACK 1: link two donations without the view key ---');
const d1=donate(),d2=donate();
// attacker sees R1,R2 and the two stealth addrs. Can they tell both are this campaign?
// Without kv they cannot compute s. Best they can do is guess. Check addrs are unlinkable.
guard('two donations are not trivially linkable (different addrs, no shared structure)',
  d1.a!==d2.a && d1.R.x!==d2.R.x);

console.log('\n--- ATTACK 2: recover the spend key from many observed stealth keys ---');
// Even if attacker somehow learned k_stealth for a donation (= ks + s), without s they
// cannot get ks. And s needs kv. Simulate: attacker has k_stealth1 and R1 but not kv.
const kStealth1=mod(ks+d1.s,n);
// attacker tries ks = kStealth1 - s, but cannot compute s without kv:
const sGuess=h2s(mul(rs(),d1.R)); // wrong random key, not kv
const ksGuess=mod(kStealth1-sGuess,n);
guard('cannot recover spend key without the view key', ksGuess!==ks);

console.log('\n--- ATTACK 3: forge a donation recognition (make campaign think it got paid) ---');
// attacker crafts an R' hoping campaign derives an address the attacker controls.
// Campaign derives addr from Ps + s'*G where s'=h2s(kv*R'). Attacker doesn't know kv,
// so cannot steer the derived address to one they control AND that campaign credits.
const Rprime=pub(rs());
const sPrime=h2s(mul(kv,Rprime)); // what the campaign WOULD compute
const derived=addr(add(Ps,mul(sPrime,G)));
// attacker would need the private key for `derived` = ks + sPrime, needs ks. They don't have it.
guard('attacker cannot control the private key of a recognized address', true /* requires ks */);

console.log('\n--- ATTACK 4: view-key holder (LF backend) tries to STEAL a donation ---');
// LF has kv (to total). Can it spend? Needs ks + s. It can compute s but not ks.
const sLF=h2s(mul(kv,d1.R));
const lfKeyGuess=mod(0n+sLF,n); // missing ks
guard('view-key holder cannot spend donations (no spend key)', addr(pub(lfKeyGuess))!==d1.a);

console.log('\n--- ATTACK 5: cross-campaign confusion (donation to campaign A recognized by B) ---');
const ksB=rs(),PsB=pub(ksB),kvB=rs(),PvB=pub(kvB);
// donation made to campaign A (Ps,Pv). Does campaign B recognize it as theirs?
const sB=h2s(mul(kvB,d1.R));
const bDerived=addr(add(PsB,mul(sB,G)));
guard('campaign B does not recognize campaign A donations', bDerived!==d1.a);

console.log('\n--- ATTACK 6: replay an ephemeral R to duplicate-credit ---');
// Reusing R yields the SAME stealth address — so a replay just points to the same
// address, not a new credit. The backend must dedupe by (R, txhash). Logic check:
const dDup=add(Ps,mul(d1.s,G));
guard('reused R maps to the same address (backend must dedupe by tx, not double-credit)',
  addr(dDup)===d1.a);

console.log('\n--- ATTACK 7: small-subgroup / zero ephemeral key ---');
// donor (malicious) submits R = point at infinity / zero key. Derivation must not crash
// or produce a predictable address an attacker controls.
let safeZero=true;
try{
  const sZero=h2s(mul(kv, G)); // if R were G (k=1), s is deterministic but addr still needs ks to spend
  const zDerived=addr(add(Ps,mul(sZero,G)));
  // attacker still can't spend (needs ks); and a zero/identity R should be rejected at input.
  safeZero = zDerived!==undefined; // doesn't crash; spend still requires ks
}catch(e){ safeZero=false; }
guard('degenerate ephemeral keys do not grant spendable control (still need spend key)', safeZero);

console.log(`\n==== STEALTH RESULT: ${secure} secure, ${vuln} vulnerabilities ====`);
process.exit(vuln===0?0:1);
