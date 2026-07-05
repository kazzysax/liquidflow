// DEEPER ADVERSARIAL SUITE — subtler logic attacks across all EVM contracts.
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
const KEYS={
  a:'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  b:'0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  c:'0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  d:'0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
};
const W=Object.fromEntries(Object.entries(KEYS).map(([k,v])=>[k,new ethers.Wallet(v)]));
const ADDR=Object.fromEntries(Object.entries(W).map(([k,w])=>[k,w.address]));
const common=new Common({chain:Chain.Mainnet,hardfork:Hardfork.Shanghai});
let secure=0,vuln=0;
const guard=(n,c)=>{ if(c){console.log('  SECURE: '+n);secure++;} else {console.log('  *** VULN *** : '+n);vuln++;} };

async function ctx(){
  const vm=await VM.create({common}); const nonces={};
  for(const a of Object.values(ADDR)){ await vm.stateManager.putAccount(new Address(hexToBytes(a)),Account.fromAccountData({balance:10n**21n})); nonces[a]=0n; }
  let clock=2_000_000n;
  const send=async(fromKey,to,data,value=0n)=>{
    const from=ADDR[fromKey];
    const tx=LegacyTransaction.fromTxData({nonce:nonces[from]++,gasPrice:10n,gasLimit:8_000_000n,to:to?new Address(hexToBytes(to)):undefined,value,data:hexToBytes(data)},{common}).sign(hexToBytes(KEYS[fromKey]));
    const block=Block.fromBlockData({header:{number:1n,timestamp:clock,gasLimit:30_000_000n,baseFeePerGas:7n}},{common});
    return vm.runTx({tx,skipBalance:true,block});
  };
  return {vm,send,bal:a=>vm.stateManager.getAccount(new Address(hexToBytes(a))).then(x=>x?x.balance:0n),
    setClock:t=>{clock=t;}, getClock:()=>clock};
}
const reverted=r=>r.execResult.exceptionError!==undefined;

async function attackGate(){
  console.log('=== PAYMENTGATE ATTACKS ===');
  const C=compileC('src/PaymentGate.sol','PaymentGate');
  const iface=new ethers.Interface(C.abi);
  const {send,bal,setClock,getClock}=await ctx();
  // merchant=a, operator=b
  const dep=await send('b',null,C.bytecode+iface.encodeDeploy([ADDR.a,ADDR.b]).slice(2));
  const G=bytesToHex(dep.createdAddress.bytes);
  const pid=ethers.id('p1');

  // A9: operator opens, attacker tries to pay LESS but via overpay then expects change? exact-match guard
  await send('b',G,iface.encodeFunctionData('openPayment',[pid,10n**18n,9_999_999_999n]));
  const over=await send('c',G,iface.encodeFunctionData('pay',[pid]),2n*10n**18n); // overpay
  guard('overpayment is rejected (exact amount enforced)', reverted(over));

  // A10: two payers race the same open payment — second must fail (already settled)
  await send('c',G,iface.encodeFunctionData('pay',[pid]),10n**18n); // correct, settles
  const second=await send('d',G,iface.encodeFunctionData('pay',[pid]),10n**18n);
  guard('cannot pay an already-settled payment', reverted(second));

  // A11: operator tries to reopen a settled id to capture a second payment
  const reopen=await send('b',G,iface.encodeFunctionData('openPayment',[pid,10n**18n,9_999_999_999n]));
  guard('operator cannot reopen a settled payment id', reverted(reopen));

  // A12: pay with amount=0 configured (the "any amount" branch) then check it still goes to merchant
  const pid2=ethers.id('p2');
  await send('b',G,iface.encodeFunctionData('openPayment',[pid2,0,9_999_999_999n])); // amount 0 = any
  const mBefore=await bal(ADDR.a);
  await send('c',G,iface.encodeFunctionData('pay',[pid2]),3n*10n**17n);
  const mAfter=await bal(ADDR.a);
  guard('any-amount payment still routes ONLY to merchant', mAfter-mBefore===3n*10n**17n);

  // A13: can a closed (never-opened) random id receive funds?
  const randomPay=await send('c',G,iface.encodeFunctionData('pay',[ethers.id('never')]),10n**18n);
  guard('paying an unopened id reverts', reverted(randomPay));
}

async function attackPayroll(){
  console.log('\n=== PAYROLLSCHEDULER ATTACKS ===');
  const C=compileC('src/PayrollScheduler.sol','PayrollScheduler');
  const iface=new ethers.Interface(C.abi);
  const {send,bal,setClock,getClock}=await ctx();
  // company=a, trigger=b
  const dep=await send('a',null,C.bytecode+iface.encodeDeploy([ADDR.a,ADDR.b]).slice(2));
  const P=bytesToHex(dep.createdAddress.bytes);
  await send('a',P,'0x',5n*10n**18n);

  // A14: over-allocation — schedule more than the balance across multiple payouts
  const t=Number(getClock())+1000;
  await send('a',P,iface.encodeFunctionData('schedule',[ADDR.c,3n*10n**18n,BigInt(t)])); // id0, alloc 3
  const overAlloc=await send('a',P,iface.encodeFunctionData('schedule',[ADDR.c,3n*10n**18n,BigInt(t)])); // would need 6 > 5
  guard('cannot over-allocate beyond balance', reverted(overAlloc));

  // A15: company withdraws funds already allocated to a payout (rug the employee)
  const rug=await send('a',P,iface.encodeFunctionData('withdrawUnallocated',[5n*10n**18n]));
  guard('company cannot withdraw allocated funds (only unallocated)', reverted(rug));

  // A16: trigger releases to employee, then tries to modify-and-replay
  setClock(BigInt(t+10));
  await send('b',P,iface.encodeFunctionData('release',[0])); // legit release id0
  const modAfter=await send('a',P,iface.encodeFunctionData('modify',[0,10n**18n,BigInt(t)]));
  guard('cannot modify an already-released payout', reverted(modAfter));

  // A17: re-release the same payout
  const reRel=await send('b',P,iface.encodeFunctionData('release',[0]));
  guard('cannot re-release a paid payout', reverted(reRel));

  // A18: trigger tries to release a not-yet-due payout
  await send('a',P,iface.encodeFunctionData('schedule',[ADDR.c,10n**18n,BigInt(t+100000)])); // id1 future
  const early=await send('b',P,iface.encodeFunctionData('release',[1]));
  guard('trigger cannot release before due time', reverted(early));

  // A19: cancel then release race
  await send('a',P,iface.encodeFunctionData('cancel',[1]));
  setClock(BigInt(t+200000));
  const relCancelled=await send('b',P,iface.encodeFunctionData('release',[1]));
  guard('cannot release a cancelled payout even after due', reverted(relCancelled));
}

async function attackWalletEdges(){
  console.log('\n=== SECUREPLATFORMWALLET EDGE ATTACKS ===');
  const C=compileC('src/SecurePlatformWallet.sol','SecurePlatformWallet');
  const iface=new ethers.Interface(C.abi);
  const {send,bal,setClock,getClock}=await ctx();
  // owners a,b threshold 2, guardian c, delays/limits
  const dargs=[[ADDR.a,ADDR.b],2,ADDR.c,3600,2n*10n**18n,3600,5n*10n**18n];
  const dep=await send('a',null,C.bytecode+iface.encodeDeploy(dargs).slice(2));
  const WAL=bytesToHex(dep.createdAddress.bytes);
  await send('c',WAL,'0x',20n*10n**18n);

  // allowlist dest=d
  await send('a',WAL,iface.encodeFunctionData('proposeAllowlist',[ADDR.d]));
  setClock(getClock()+3601n);
  await send('a',WAL,iface.encodeFunctionData('activateAllowlist',[ADDR.d]));

  // A20: velocity bypass via many small withdrawals in one window
  // daily limit 5 ETH. Do 5 x 1 ETH (ok), then 6th must fail.
  let blocked=false;
  for(let i=0;i<6;i++){
    const idResp=await send('a',WAL,iface.encodeFunctionData('proposeWithdrawNative',[ADDR.d,10n**18n]));
    // proposal id is i (all by a, each auto-approved=1), need b to approve
    if(reverted(idResp)){ blocked=true; break; }
    await send('b',WAL,iface.encodeFunctionData('approve',[i]));
    const ex=await send('a',WAL,iface.encodeFunctionData('execute',[i]));
    if(reverted(ex)){ blocked=true; break; }
  }
  guard('velocity cap blocks the 6th 1-ETH withdrawal (5 ETH/day enforced)', blocked);

  // A21: re-activate a cancelled allowlist entry without a new delay
  const pidDest=ADDR.a; // some other address
  await send('a',WAL,iface.encodeFunctionData('proposeAllowlist',[pidDest]));
  await send('c',WAL,iface.encodeFunctionData('cancelAllowlist',[pidDest])); // guardian cancels
  const actCancelled=await send('a',WAL,iface.encodeFunctionData('activateAllowlist',[pidDest]));
  guard('cannot activate a cancelled allowlist entry', reverted(actCancelled));
}

async function main(){
  await attackGate();
  await attackPayroll();
  await attackWalletEdges();
  console.log(`\n==== TOTAL: ${secure} secure, ${vuln} vulnerabilities ====`);
  process.exit(vuln===0?0:1);
}
main().catch(e=>{console.error(e);process.exit(1);});
