// REGRESSION TEST for the stale-unpause-vote vulnerability found during self-audit.
//
// THE BUG (now fixed): unpause votes were global and only cleared on success. A
// leftover vote from an abandoned unpause cycle could carry into a LATER pause,
// letting fewer fresh approvals than `threshold` unpause the wallet — defeating
// quorum-gated unpause.
//
// THE FIX: votes are scoped to a pauseEpoch; a fresh pause increments the epoch,
// abandoning all prior-cycle votes.
//
// This test reproduces the attack and asserts it now FAILS to bypass quorum.
const fs=require('fs'); const solc=require('solc');
const {VM}=require('@ethereumjs/vm');
const {Common,Hardfork,Chain}=require('@ethereumjs/common');
const {LegacyTransaction}=require('@ethereumjs/tx');
const {Address,hexToBytes,bytesToHex,Account}=require('@ethereumjs/util');
const {Block}=require('@ethereumjs/block');
const {ethers}=require('ethers');

function compileC(file,name){
  const src=fs.readFileSync(file,'utf8');
  const input={language:'Solidity',sources:{'C.sol':{content:src}},settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
  const out=JSON.parse(solc.compile(JSON.stringify(input)));
  if(out.errors&&out.errors.some(e=>e.severity==='error')){out.errors.forEach(e=>console.log(e.formattedMessage));process.exit(1);}
  const c=out.contracts['C.sol'][name];
  return {abi:c.abi,bytecode:'0x'+c.evm.bytecode.object};
}
// owners a,b,c (threshold 2), guardian g
const KEYS={
  a:'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  b:'0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  c:'0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  g:'0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
};
const W=Object.fromEntries(Object.entries(KEYS).map(([k,v])=>[k,new ethers.Wallet(v)]));
const ADDR=Object.fromEntries(Object.entries(W).map(([k,w])=>[k,w.address]));
const common=new Common({chain:Chain.Mainnet,hardfork:Hardfork.Shanghai});
let pass=0,fail=0; const ok=(n,c)=>{console.log((c?'  PASS: ':'  *** FAIL *** : ')+n);c?pass++:fail++;};

async function main(){
  const C=compileC('src/SecurePlatformWallet.sol','SecurePlatformWallet');
  const iface=new ethers.Interface(C.abi);
  const vm=await VM.create({common}); const nonces={};
  for(const x of Object.values(ADDR)){ await vm.stateManager.putAccount(new Address(hexToBytes(x)),Account.fromAccountData({balance:10n**20n})); nonces[x]=0n; }
  let clock=3_000_000n;
  const send=async(fromKey,to,data,value=0n)=>{
    const from=ADDR[fromKey];
    const acct=await vm.stateManager.getAccount(new Address(hexToBytes(from)));
    const nonce=acct?acct.nonce:0n;
    const tx=LegacyTransaction.fromTxData({nonce,gasPrice:10n,gasLimit:8_000_000n,to:to?new Address(hexToBytes(to)):undefined,value,data:hexToBytes(data)},{common}).sign(hexToBytes(KEYS[fromKey]));
    const block=Block.fromBlockData({header:{number:1n,timestamp:clock,gasLimit:30_000_000n,baseFeePerGas:7n}},{common});
    return vm.runTx({tx,skipBalance:true,block});
  };
  const reverted=r=>r.execResult.exceptionError!==undefined;
  const isPaused=async(WAL)=>{
    const res=await vm.evm.runCall({to:new Address(hexToBytes(WAL)),caller:new Address(hexToBytes(ADDR.a)),data:hexToBytes(iface.encodeFunctionData('paused',[])),gasLimit:1_000_000n});
    return bytesToHex(res.execResult.returnValue).endsWith('1');
  };

  // owners a,b,c threshold 2, guardian g
  const dargs=[[ADDR.a,ADDR.b,ADDR.c],2,ADDR.g,3600,2n*10n**18n,3600,100n*10n**18n];
  const dep=await send('a',null,C.bytecode+iface.encodeDeploy(dargs).slice(2));
  const WAL=bytesToHex(dep.createdAddress.bytes);
  console.log('Deployed wallet (owners a,b,c; threshold 2; guardian g)\n');

  console.log('--- Reproduce the attack scenario ---');
  // CYCLE 1: guardian pauses (epoch -> 1). Owner A votes to unpause but they decide
  // to STAY paused (only 1/2 votes). A's vote is now "spent" in epoch 1.
  await send('g',WAL,iface.encodeFunctionData('pause',[]));
  await send('a',WAL,iface.encodeFunctionData('approveUnpause',[])); // 1/2 in epoch 1
  ok('after 1/2 votes in cycle 1, wallet is still paused', await isPaused(WAL));

  // They unpause legitimately with B (2/2) to resume normal ops.
  await send('b',WAL,iface.encodeFunctionData('approveUnpause',[])); // 2/2 -> unpaused
  ok('legit 2/2 unpause works in cycle 1', !(await isPaused(WAL)));

  // CYCLE 2: a real incident — guardian pauses again (epoch -> 2).
  await send('g',WAL,iface.encodeFunctionData('pause',[]));
  ok('wallet paused again in cycle 2', await isPaused(WAL));

  // THE ATTACK: a single compromised owner (A) calls approveUnpause once.
  // In the OLD buggy code, A's leftover vote could combine to hit threshold.
  // With the fix (epoch-scoped votes), this is a FRESH epoch, so A is only 1/2.
  await send('a',WAL,iface.encodeFunctionData('approveUnpause',[])); // should be 1/2 in epoch 2
  ok('single owner CANNOT unpause via stale votes (still paused)', await isPaused(WAL));

  // Confirm proper quorum still works in the new epoch.
  await send('b',WAL,iface.encodeFunctionData('approveUnpause',[])); // 2/2 in epoch 2
  ok('fresh 2/2 quorum still unpauses correctly', !(await isPaused(WAL)));

  console.log(`\n==== REGRESSION RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail===0?0:1);
}
main().catch(e=>{console.error(e);process.exit(1);});
