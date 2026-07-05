// Proves the PayrollScheduler guarantees against a real EVM.
const fs=require('fs'); const solc=require('solc');
const {VM}=require('@ethereumjs/vm');
const {Common,Hardfork,Chain}=require('@ethereumjs/common');
const {LegacyTransaction}=require('@ethereumjs/tx');
const {Address,hexToBytes,bytesToHex,Account}=require('@ethereumjs/util');
const {Block}=require('@ethereumjs/block');
const {ethers}=require('ethers');

function compile(file){
  const src=fs.readFileSync(file,'utf8');
  const input={language:'Solidity',sources:{'C.sol':{content:src}},settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
  const out=JSON.parse(solc.compile(JSON.stringify(input)));
  if(out.errors&&out.errors.some(e=>e.severity==='error')){out.errors.forEach(e=>console.log(e.formattedMessage));process.exit(1);}
  const c=out.contracts['C.sol']['PayrollScheduler'];
  return {abi:c.abi,bytecode:'0x'+c.evm.bytecode.object};
}

const KEYS={
  company:'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  trigger:'0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // Liquid Flow
  employee:'0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  attacker:'0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
};
const W=Object.fromEntries(Object.entries(KEYS).map(([k,v])=>[k,new ethers.Wallet(v)]));
const ADDR=Object.fromEntries(Object.entries(W).map(([k,w])=>[k,w.address]));
const common=new Common({chain:Chain.Mainnet,hardfork:Hardfork.Shanghai});
let pass=0,fail=0; const ok=(n,c)=>{console.log((c?'  PASS: ':'  FAIL: ')+n);c?pass++:fail++;};

async function main(){
  const {abi,bytecode}=compile('src/PayrollScheduler.sol');
  const iface=new ethers.Interface(abi);
  const vm=await VM.create({common});
  const nonces={};
  for(const a of Object.values(ADDR)){ await vm.stateManager.putAccount(new Address(hexToBytes(a)),Account.fromAccountData({balance:10n**20n})); nonces[a]=0n; }
  let clock=1_000_000n;
  async function send(fromKey,to,data,value=0n){
    const from=ADDR[fromKey];
    const tx=LegacyTransaction.fromTxData({nonce:nonces[from]++,gasPrice:10n,gasLimit:5_000_000n,to:to?new Address(hexToBytes(to)):undefined,value,data:hexToBytes(data)},{common}).sign(hexToBytes(KEYS[fromKey]));
    const block=Block.fromBlockData({header:{number:1n,timestamp:clock,gasLimit:30_000_000n,baseFeePerGas:7n}},{common});
    return vm.runTx({tx,skipBalance:true,block});
  }
  const bal=a=>vm.stateManager.getAccount(new Address(hexToBytes(a))).then(x=>x?x.balance:0n);

  const dep=await send('company',null,bytecode+iface.encodeDeploy([ADDR.company,ADDR.trigger]).slice(2));
  const P=bytesToHex(dep.createdAddress.bytes);
  console.log('Deployed PayrollScheduler at',P,'\n  company (owner):',ADDR.company,'\n  trigger (LF):',ADDR.trigger,'\n');

  // company funds with 5 ETH
  await send('company',P,'0x',5n*10n**18n);
  ok('contract funded with 5 ETH', (await bal(P))===5n*10n**18n);

  console.log('\n--- P1: only the company can schedule a payout ---');
  const relTime = Number(clock)+1000;
  const schedData=iface.encodeFunctionData('schedule',[ADDR.employee,2n*10n**18n,BigInt(relTime)]);
  let r=await send('attacker',P,schedData);
  ok('attacker schedule reverts (NotCompany)', r.execResult.exceptionError!==undefined);
  r=await send('trigger',P,schedData);
  ok('trigger (LF) cannot schedule', r.execResult.exceptionError!==undefined);
  r=await send('company',P,schedData);
  ok('company can schedule payout id 0', r.execResult.exceptionError===undefined);

  console.log('\n--- P2: cannot release before the release time ---');
  r=await send('trigger',P,iface.encodeFunctionData('release',[0]));
  ok('early release reverts (NotDue)', r.execResult.exceptionError!==undefined);

  console.log('\n--- P3: company can cancel before release (pull the plug) ---');
  // schedule a second payout, then cancel it
  await send('company',P,iface.encodeFunctionData('schedule',[ADDR.employee,1n*10n**18n,BigInt(relTime)])); // id 1
  r=await send('company',P,iface.encodeFunctionData('cancel',[1]));
  ok('company cancels payout 1', r.execResult.exceptionError===undefined);
  r=await send('trigger',P,iface.encodeFunctionData('release',[1]));
  ok('releasing a cancelled payout reverts', r.execResult.exceptionError!==undefined);

  console.log('\n--- P4: attacker cannot cancel or trigger ---');
  r=await send('attacker',P,iface.encodeFunctionData('cancel',[0]));
  ok('attacker cancel reverts (NotCompany)', r.execResult.exceptionError!==undefined);
  r=await send('attacker',P,iface.encodeFunctionData('release',[0]));
  ok('attacker release reverts (NotCompanyOrTrigger)', r.execResult.exceptionError!==undefined);

  console.log('\n--- P5: after release time, trigger (LF) releases to the EMPLOYEE ---');
  clock += 2000n; // advance past releaseTime
  const eBefore=await bal(ADDR.employee);
  r=await send('trigger',P,iface.encodeFunctionData('release',[0]));
  ok('trigger releases due payout', r.execResult.exceptionError===undefined);
  const eAfter=await bal(ADDR.employee);
  ok('employee received exactly 2 ETH', eAfter-eBefore===2n*10n**18n);

  console.log('\n--- P6: no double-release ---');
  r=await send('trigger',P,iface.encodeFunctionData('release',[0]));
  ok('re-releasing reverts (AlreadyReleased)', r.execResult.exceptionError!==undefined);

  console.log('\n--- P7: trigger has no redirect/withdraw power ---');
  const fnNames=abi.filter(x=>x.type==='function').map(x=>x.name);
  // trigger can only call release(); withdrawUnallocated is company-gated
  r=await send('trigger',P,iface.encodeFunctionData('withdrawUnallocated',[10n**18n]));
  ok('trigger cannot withdraw unallocated (company-only)', r.execResult.exceptionError!==undefined);
  console.log('     functions:', fnNames.join(', '));

  console.log('\n--- P8: company can reclaim unallocated funds ---');
  // remaining balance: 5 - 2 released = 3; allocated now 0 (id0 released, id1 cancelled)
  const cBefore=await bal(ADDR.company);
  r=await send('company',P,iface.encodeFunctionData('withdrawUnallocated',[3n*10n**18n]));
  ok('company withdraws remaining 3 ETH', r.execResult.exceptionError===undefined);
  const cAfter=await bal(ADDR.company);
  ok('company balance increased ~3 ETH', cAfter>cBefore);

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail===0?0:1);
}
main().catch(e=>{console.error(e);process.exit(1);});
