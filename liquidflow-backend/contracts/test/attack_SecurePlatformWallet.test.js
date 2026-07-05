// ADVERSARIAL TEST SUITE — actively tries to break SecurePlatformWallet.
// Each "attack" attempts to violate a guarantee. We WANT these to fail (revert).
// If an attack SUCCEEDS, that's a real vulnerability printed as VULN.
const fs=require('fs'); const solc=require('solc');
const {VM}=require('@ethereumjs/vm');
const {Common,Hardfork,Chain}=require('@ethereumjs/common');
const {LegacyTransaction}=require('@ethereumjs/tx');
const {Address,hexToBytes,bytesToHex,Account}=require('@ethereumjs/util');
const {Block}=require('@ethereumjs/block');
const {ethers}=require('ethers');

function compileFile(file, name){
  const src=fs.readFileSync(file,'utf8');
  const input={language:'Solidity',sources:{'C.sol':{content:src}},settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
  const out=JSON.parse(solc.compile(JSON.stringify(input)));
  if(out.errors&&out.errors.some(e=>e.severity==='error')){out.errors.forEach(e=>console.log(e.formattedMessage));process.exit(1);}
  const c=out.contracts['C.sol'][name];
  return {abi:c.abi,bytecode:'0x'+c.evm.bytecode.object};
}

// A malicious reentrancy contract that tries to re-enter execute() on receive.
const ATTACKER_SRC = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
interface IWallet { function execute(uint256 id) external; }
contract ReentrantAttacker {
    IWallet public wallet;
    uint256 public targetId;
    bool public reentered;
    constructor(address w){ wallet = IWallet(w); }
    function setTarget(uint256 id) external { targetId = id; }
    receive() external payable {
        if (!reentered) { reentered = true; try wallet.execute(targetId) {} catch {} }
    }
}`;

const KEYS={
  ownerA:'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  ownerB:'0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  guardian:'0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  attacker:'0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  dest:'0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
};
const W=Object.fromEntries(Object.entries(KEYS).map(([k,v])=>[k,new ethers.Wallet(v)]));
const ADDR=Object.fromEntries(Object.entries(W).map(([k,w])=>[k,w.address]));
const common=new Common({chain:Chain.Mainnet,hardfork:Hardfork.Shanghai});

let secure=0, vuln=0;
const guard=(n,attackReverted)=>{ if(attackReverted){console.log('  SECURE: '+n);secure++;} else {console.log('  *** VULN *** : '+n);vuln++;} };

async function main(){
  const wallet=compileFile('src/SecurePlatformWallet.sol','SecurePlatformWallet');
  const atk=compileFile('/tmp/attacker.sol','ReentrantAttacker');
  const iface=new ethers.Interface(wallet.abi);
  const atkIface=new ethers.Interface(atk.abi);
  const vm=await VM.create({common});
  const nonces={};
  for(const a of Object.values(ADDR)){ await vm.stateManager.putAccount(new Address(hexToBytes(a)),Account.fromAccountData({balance:10n**20n})); nonces[a]=0n; }
  let clock=1_000_000n;
  async function send(fromKey,to,data,value=0n){
    const from=ADDR[fromKey];
    const tx=LegacyTransaction.fromTxData({nonce:nonces[from]++,gasPrice:10n,gasLimit:8_000_000n,to:to?new Address(hexToBytes(to)):undefined,value,data:hexToBytes(data)},{common}).sign(hexToBytes(KEYS[fromKey]));
    const block=Block.fromBlockData({header:{number:1n,timestamp:clock,gasLimit:30_000_000n,baseFeePerGas:7n}},{common});
    return vm.runTx({tx,skipBalance:true,block});
  }
  const bal=a=>vm.stateManager.getAccount(new Address(hexToBytes(a))).then(x=>x?x.balance:0n);
  const reverted=r=>r.execResult.exceptionError!==undefined;

  // deploy wallet: owners A,B, threshold 2, guardian, delay 1h, large 2e18, allowlistDelay 1h, daily 100e18
  const dargs=[[ADDR.ownerA,ADDR.ownerB],2,ADDR.guardian,3600,2n*10n**18n,3600,100n*10n**18n];
  const dep=await send('ownerA',null,wallet.bytecode+iface.encodeDeploy(dargs).slice(2));
  const WAL=bytesToHex(dep.createdAddress.bytes);
  await send('guardian',WAL,'0x',10n**19n); // fund 10 ETH
  console.log('Target wallet:',WAL,'funded 10 ETH\n');

  console.log('=== ATTACK 1: drain via reentrancy ===');
  // deploy attacker, allowlist it, schedule a small withdrawal to it, then see if
  // its receive() can re-enter execute() to double-withdraw.
  const adep=await send('attacker',null,atk.bytecode+atkIface.encodeDeploy([WAL]).slice(2));
  const ATK=bytesToHex(adep.createdAddress.bytes);
  // owners allowlist the attacker contract (simulating a legit payee that's malicious)
  await send('ownerA',WAL,iface.encodeFunctionData('proposeAllowlist',[ATK]));
  clock+=3601n;
  await send('ownerA',WAL,iface.encodeFunctionData('activateAllowlist',[ATK]));
  // small withdrawal (below large threshold so no timelock) 1 ETH to attacker
  await send('ownerA',WAL,iface.encodeFunctionData('proposeWithdrawNative',[ATK,10n**18n])); // id0
  await send('ownerB',WAL,iface.encodeFunctionData('approve',[0]));
  await send('attacker',ATK,atkIface.encodeFunctionData('setTarget',[0]));
  const balBefore=await bal(WAL);
  await send('ownerA',WAL,iface.encodeFunctionData('execute',[0]));
  const balAfter=await bal(WAL);
  const drained = balBefore - balAfter;
  // legit withdrawal removes exactly 1 ETH; reentrancy would remove 2+.
  guard('reentrancy cannot double-withdraw (drained exactly 1 ETH)', drained === 10n**18n);
  console.log('     drained:', ethers.formatEther(drained), 'ETH (expected 1.0)');

  console.log('\n=== ATTACK 2: bypass quorum by approving from same owner twice ===');
  await send('ownerA',WAL,iface.encodeFunctionData('proposeWithdrawNative',[ATK,10n**18n])); // id1, A=1
  const dbl=await send('ownerA',WAL,iface.encodeFunctionData('approve',[1])); // A again
  // try execute with only A's (duplicate) approval
  const ex=await send('ownerA',WAL,iface.encodeFunctionData('execute',[1]));
  guard('cannot execute with one owner double-approving', reverted(ex));

  console.log('\n=== ATTACK 3: attacker self-approves a proposal ===');
  const atkProp=await send('attacker',WAL,iface.encodeFunctionData('proposeWithdrawNative',[ATK,10n**18n]));
  guard('attacker cannot even propose', reverted(atkProp));

  console.log('\n=== ATTACK 4: guardian tries to move funds (should only pause/cancel) ===');
  const gProp=await send('guardian',WAL,iface.encodeFunctionData('proposeWithdrawNative',[ATK,10n**18n]));
  guard('guardian cannot propose withdrawals', reverted(gProp));

  console.log('\n=== ATTACK 5: skip allowlist — withdraw to a fresh attacker address ===');
  const fresh=ADDR.attacker;
  await send('ownerA',WAL,iface.encodeFunctionData('proposeWithdrawNative',[fresh,10n**18n]))
    .then(r=>guard('cannot propose to non-allowlisted address', reverted(r)));

  console.log('\n=== ATTACK 6: bypass timelock on a large withdrawal ===');
  await send('ownerA',WAL,iface.encodeFunctionData('proposeWithdrawNative',[ATK,3n*10n**18n])); // id large
  // figure out the id: proposals so far: 0,1,(2 failed propose by attacker doesn't count? it reverted)
  // ids that succeeded: 0,1, and this one. attacker propose reverted so no id. so this is id2.
  await send('ownerB',WAL,iface.encodeFunctionData('approve',[2]));
  const earlyBig=await send('ownerA',WAL,iface.encodeFunctionData('execute',[2]));
  guard('cannot execute large withdrawal before timelock', reverted(earlyBig));

  console.log('\n=== ATTACK 7: unpause with a single key after guardian pauses ===');
  await send('guardian',WAL,iface.encodeFunctionData('pause',[]));
  await send('ownerA',WAL,iface.encodeFunctionData('approveUnpause',[])); // 1/2
  const stillPaused=await send('ownerA',WAL,iface.encodeFunctionData('proposeWithdrawNative',[ATK,10n**17n]));
  guard('single key cannot unpause (still paused after 1/2)', reverted(stillPaused));

  console.log('\n=== ATTACK 8: re-execute an already-executed proposal ===');
  // unpause properly first
  await send('ownerB',WAL,iface.encodeFunctionData('approveUnpause',[]));
  const reExec=await send('ownerA',WAL,iface.encodeFunctionData('execute',[0])); // id0 already done
  guard('cannot re-execute a completed proposal', reverted(reExec));

  console.log(`\n==== RESULT: ${secure} secure, ${vuln} vulnerabilities ====`);
  process.exit(vuln===0?0:1);
}

fs.writeFileSync('/tmp/attacker.sol', ATTACKER_SRC);
main().catch(e=>{console.error(e);process.exit(1);});
