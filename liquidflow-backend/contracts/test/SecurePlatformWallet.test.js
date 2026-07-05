// Proves the SecurePlatformWallet defense-in-depth controls against a real EVM.
const fs = require('fs');
const solc = require('solc');
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const { LegacyTransaction } = require('@ethereumjs/tx');
const { Address, hexToBytes, bytesToHex, Account } = require('@ethereumjs/util');
const { ethers } = require('ethers');
const { Block } = require('@ethereumjs/block');

function compile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const input = { language: 'Solidity', sources: { 'C.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors && out.errors.some(e => e.severity === 'error')) { out.errors.forEach(e=>console.log(e.formattedMessage)); process.exit(1); }
  const c = out.contracts['C.sol']['SecurePlatformWallet'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

const KEYS = {
  ownerA: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  ownerB: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  guardian: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  dest: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  attacker: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
};
const wallets = Object.fromEntries(Object.entries(KEYS).map(([k,v])=>[k,new ethers.Wallet(v)]));
const ADDR = Object.fromEntries(Object.entries(wallets).map(([k,w])=>[k,w.address]));
const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });

let pass=0, fail=0;
function check(name, cond){ if(cond){console.log('  PASS:',name);pass++;}else{console.log('  FAIL:',name);fail++;} }

async function main(){
  const { abi, bytecode } = compile('src/SecurePlatformWallet.sol');
  const iface = new ethers.Interface(abi);
  const vm = await VM.create({ common });
  const nonces = {};
  for (const a of Object.values(ADDR)) {
    const addr = new Address(hexToBytes(a));
    const acct = Account.fromAccountData({ balance: 10n**20n });
    await vm.stateManager.putAccount(addr, acct);
    nonces[a]=0n;
  }
  // current EVM time helper: we advance by setting block timestamps via runTx opts
  let clock = 1_000_000n;
  async function send(fromKey, to, data, value=0n){
    const from = ADDR[fromKey];
    const tx = LegacyTransaction.fromTxData({ nonce: nonces[from]++, gasPrice: 10n, gasLimit: 8_000_000n,
      to: to?new Address(hexToBytes(to)):undefined, value, data: hexToBytes(data) }, { common }).sign(hexToBytes(KEYS[fromKey]));
    const block = Block.fromBlockData({ header: { number: 1n, timestamp: clock, gasLimit: 30_000_000n, baseFeePerGas: 7n } }, { common });
    return vm.runTx({ tx, skipBalance: true, block });
  }
  function bal(a){ return vm.stateManager.getAccount(new Address(hexToBytes(a))).then(x=>x?x.balance:0n); }

  // Deploy: owners A,B; threshold 2; guardian; withdrawDelay 1h; large=2 ETH;
  // allowlistDelay 1h; dailyLimit 3 ETH.
  const args = [[ADDR.ownerA, ADDR.ownerB], 2, ADDR.guardian, 3600, 2n*10n**18n, 3600, 3n*10n**18n];
  const deployData = bytecode + iface.encodeDeploy(args).slice(2);
  const dep = await send('ownerA', null, deployData);
  const W = bytesToHex(dep.createdAddress.bytes);
  console.log('Deployed SecurePlatformWallet at', W, '\n');
  await send('guardian', W, '0x', 10n**19n); // fund 10 ETH

  console.log('--- CONTROL 1: cannot withdraw to a non-allowlisted destination ---');
  let r = await send('ownerA', W, iface.encodeFunctionData('proposeWithdrawNative', [ADDR.dest, 10n**18n]));
  check('propose to non-allowlisted dest reverts (DestinationNotAllowed)', r.execResult.exceptionError !== undefined);

  console.log('\n--- CONTROL 2: allowlist addition is time-delayed; cannot activate early ---');
  await send('ownerA', W, iface.encodeFunctionData('proposeAllowlist', [ADDR.dest]));
  r = await send('ownerA', W, iface.encodeFunctionData('activateAllowlist', [ADDR.dest]));
  check('activating allowlist before delay reverts (PendingNotReady)', r.execResult.exceptionError !== undefined);
  // guardian can cancel during the window
  const r2 = await send('guardian', W, iface.encodeFunctionData('cancelAllowlist', [ADDR.dest]));
  check('guardian can cancel a pending allowlist add', r2.execResult.exceptionError === undefined);

  console.log('\n--- re-add and advance time to activate ---');
  await send('ownerA', W, iface.encodeFunctionData('proposeAllowlist', [ADDR.dest]));
  clock += 3601n; // advance past allowlistDelay
  const act = await send('ownerA', W, iface.encodeFunctionData('activateAllowlist', [ADDR.dest]));
  check('allowlist activates after delay', act.execResult.exceptionError === undefined);

  console.log('\n--- CONTROL 3: small withdrawal (<2 ETH) executes immediately with quorum ---');
  await send('ownerA', W, iface.encodeFunctionData('proposeWithdrawNative', [ADDR.dest, 10n**18n])); // id0, A approves
  await send('ownerB', W, iface.encodeFunctionData('approve', [0]));
  const destBefore = await bal(ADDR.dest);
  const ex = await send('ownerA', W, iface.encodeFunctionData('execute', [0]));
  check('small withdrawal executes with 2/2 + no timelock', ex.execResult.exceptionError === undefined);
  check('1 ETH delivered', (await bal(ADDR.dest)) - destBefore === 10n**18n);

  console.log('\n--- CONTROL 4: large withdrawal (>=2 ETH) is time-locked ---');
  await send('ownerA', W, iface.encodeFunctionData('proposeWithdrawNative', [ADDR.dest, 2n*10n**18n])); // id1
  await send('ownerB', W, iface.encodeFunctionData('approve', [1]));
  const early = await send('ownerA', W, iface.encodeFunctionData('execute', [1]));
  check('large withdrawal blocked before timelock (TimelockNotElapsed)', early.execResult.exceptionError !== undefined);
  clock += 3601n; // advance past withdrawDelay
  const late = await send('ownerA', W, iface.encodeFunctionData('execute', [1]));
  check('large withdrawal succeeds after timelock', late.execResult.exceptionError === undefined);

  console.log('\n--- CONTROL 5: velocity cap blocks exceeding 3 ETH / 24h ---');
  // Already sent 1 + 2 = 3 ETH this window. Next withdrawal should exceed cap.
  await send('ownerA', W, iface.encodeFunctionData('proposeWithdrawNative', [ADDR.dest, 10n**18n])); // id2
  await send('ownerB', W, iface.encodeFunctionData('approve', [2]));
  const over = await send('ownerA', W, iface.encodeFunctionData('execute', [2]));
  check('withdrawal exceeding daily velocity reverts (VelocityExceeded)', over.execResult.exceptionError !== undefined);
  clock += 86401n; // advance 24h -> window resets
  const afterReset = await send('ownerA', W, iface.encodeFunctionData('execute', [2]));
  check('same withdrawal succeeds after 24h window reset', afterReset.execResult.exceptionError === undefined);

  console.log('\n--- CONTROL 6: circuit breaker — guardian pauses, withdrawals blocked ---');
  await send('guardian', W, iface.encodeFunctionData('pause', []));
  const whilePaused = await send('ownerA', W, iface.encodeFunctionData('proposeWithdrawNative', [ADDR.dest, 10n**17n]));
  check('proposing while paused reverts (Paused)', whilePaused.execResult.exceptionError !== undefined);

  console.log('\n--- CONTROL 7: unpause requires quorum, not a single key ---');
  await send('ownerA', W, iface.encodeFunctionData('approveUnpause', []));
  // still paused after 1/2
  const stillPaused = await send('ownerA', W, iface.encodeFunctionData('proposeWithdrawNative', [ADDR.dest, 10n**17n]));
  check('still paused after 1/2 unpause approvals', stillPaused.execResult.exceptionError !== undefined);
  await send('ownerB', W, iface.encodeFunctionData('approveUnpause', []));
  const resumed = await send('ownerA', W, iface.encodeFunctionData('proposeWithdrawNative', [ADDR.dest, 10n**17n]));
  check('resumes after 2/2 unpause approvals', resumed.execResult.exceptionError === undefined);

  console.log('\n--- CONTROL 8: attacker with NO keys can do nothing ---');
  const atk = await send('attacker', W, iface.encodeFunctionData('proposeWithdrawNative', [ADDR.attacker, 10n**18n]));
  check('attacker proposal reverts (NotOwner)', atk.execResult.exceptionError !== undefined);
  const atkPause = await send('attacker', W, iface.encodeFunctionData('pause', []));
  check('attacker cannot pause (NotOwnerOrGuardian)', atkPause.execResult.exceptionError !== undefined);

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail===0?0:1);
}
main().catch(e=>{console.error(e);process.exit(1);});
