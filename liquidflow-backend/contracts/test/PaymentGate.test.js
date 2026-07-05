// Proves the PaymentGate guarantees against a real EVM.
const fs = require('fs');
const solc = require('solc');
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const { LegacyTransaction } = require('@ethereumjs/tx');
const { Address, hexToBytes, bytesToHex, Account } = require('@ethereumjs/util');
const { Block } = require('@ethereumjs/block');
const { ethers } = require('ethers');

function compile(file){
  const src=fs.readFileSync(file,'utf8');
  const input={language:'Solidity',sources:{'C.sol':{content:src}},settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
  const out=JSON.parse(solc.compile(JSON.stringify(input)));
  if(out.errors&&out.errors.some(e=>e.severity==='error')){out.errors.forEach(e=>console.log(e.formattedMessage));process.exit(1);}
  const c=out.contracts['C.sol']['PaymentGate'];
  return {abi:c.abi,bytecode:'0x'+c.evm.bytecode.object};
}

const KEYS={
  operator:'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // Liquid Flow
  merchant:'0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  payer:'0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  attacker:'0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
};
const W=Object.fromEntries(Object.entries(KEYS).map(([k,v])=>[k,new ethers.Wallet(v)]));
const ADDR=Object.fromEntries(Object.entries(W).map(([k,w])=>[k,w.address]));
const common=new Common({chain:Chain.Mainnet,hardfork:Hardfork.Shanghai});
let pass=0,fail=0; const ok=(n,c)=>{console.log((c?'  PASS: ':'  FAIL: ')+n);c?pass++:fail++;};
const pid = ethers.id('order-4471'); // bytes32 paymentId

async function main(){
  const {abi,bytecode}=compile('src/PaymentGate.sol');
  const iface=new ethers.Interface(abi);
  const vm=await VM.create({common});
  const nonces={};
  for(const a of Object.values(ADDR)){ await vm.stateManager.putAccount(new Address(hexToBytes(a)), Account.fromAccountData({balance:10n**20n})); nonces[a]=0n; }
  let clock=1_000_000n;
  async function send(fromKey,to,data,value=0n){
    const from=ADDR[fromKey];
    const tx=LegacyTransaction.fromTxData({nonce:nonces[from]++,gasPrice:10n,gasLimit:5_000_000n,to:to?new Address(hexToBytes(to)):undefined,value,data:hexToBytes(data)},{common}).sign(hexToBytes(KEYS[fromKey]));
    const block=Block.fromBlockData({header:{number:1n,timestamp:clock,gasLimit:30_000_000n,baseFeePerGas:7n}},{common});
    return vm.runTx({tx,skipBalance:true,block});
  }
  const bal=a=>vm.stateManager.getAccount(new Address(hexToBytes(a))).then(x=>x?x.balance:0n);

  // deploy: merchant hardcoded, operator = Liquid Flow
  const deployData=bytecode+iface.encodeDeploy([ADDR.merchant, ADDR.operator]).slice(2);
  const dep=await send('operator',null,deployData);
  const G=bytesToHex(dep.createdAddress.bytes);
  console.log('Deployed PaymentGate at',G,'\n  merchant (immutable):',ADDR.merchant,'\n  operator (LF):',ADDR.operator,'\n');

  console.log('--- G1: a closed gate REJECTS native deposits ---');
  let r=await send('payer',G,'0x',10n**18n); // raw send, no open payment
  ok('sending to a closed gate reverts', r.execResult.exceptionError!==undefined);

  console.log('\n--- G2: only the operator can open a payment ---');
  const openData=iface.encodeFunctionData('openPayment',[pid, 10n**18n, 9_999_999_999n]);
  r=await send('attacker',G,openData);
  ok('attacker openPayment reverts (NotOperator)', r.execResult.exceptionError!==undefined);
  r=await send('merchant',G,openData);
  ok('even merchant cannot open (operator-only)', r.execResult.exceptionError!==undefined);
  r=await send('operator',G,openData);
  ok('operator can open the payment', r.execResult.exceptionError===undefined);

  console.log('\n--- G3: wrong amount is rejected ---');
  r=await send('payer',G,iface.encodeFunctionData('pay',[pid]), 5n*10n**17n); // 0.5 != 1
  ok('paying the wrong amount reverts (WrongAmount)', r.execResult.exceptionError!==undefined);

  console.log('\n--- G4: correct payment settles INSTANTLY to the merchant ---');
  const mBefore=await bal(ADDR.merchant);
  r=await send('payer',G,iface.encodeFunctionData('pay',[pid]), 10n**18n);
  ok('correct payment succeeds', r.execResult.exceptionError===undefined);
  const mAfter=await bal(ADDR.merchant);
  ok('merchant received exactly 1 ETH', mAfter-mBefore===10n**18n);
  const gateBal=await bal(G);
  ok('gate holds zero (funds never rest here)', gateBal===0n);

  console.log('\n--- G5: a settled payment cannot be replayed ---');
  r=await send('operator',G,openData); // try reopen same id
  ok('reopening a settled payment reverts (AlreadyUsed)', r.execResult.exceptionError!==undefined);

  console.log('\n--- G6: operator has NO withdraw/redirect function at all ---');
  // The ABI exposes no function that sends funds anywhere but `merchant`.
  const fnNames=abi.filter(x=>x.type==='function').map(x=>x.name);
  const dangerous=fnNames.filter(n=>/withdraw|sweep|transfer|setMerchant|rescue/i.test(n));
  ok('no withdraw/redirect/setMerchant function exists', dangerous.length===0);
  console.log('     functions:', fnNames.join(', '));

  console.log('\n--- G7: expired gate rejects payment ---');
  const pid2=ethers.id('order-9000');
  await send('operator',G,iface.encodeFunctionData('openPayment',[pid2,10n**18n, BigInt(Number(clock)+10)]));
  clock += 100n; // advance past expiry
  r=await send('payer',G,iface.encodeFunctionData('pay',[pid2]),10n**18n);
  ok('paying an expired gate reverts (PaymentExpired)', r.execResult.exceptionError!==undefined);

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail===0?0:1);
}
main().catch(e=>{console.error(e);process.exit(1);});
