// Executes the compiled PlatformWallet against a real EVM and asserts the
// non-custodial security guarantees. Exits non-zero if any assertion fails.
const fs = require('fs');
const solc = require('solc');
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const { LegacyTransaction } = require('@ethereumjs/tx');
const { Address, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { ethers } = require('ethers');

// ---- compile ----
function compile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'C.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors && out.errors.some(e => e.severity === 'error')) {
    out.errors.forEach(e => console.log(e.formattedMessage));
    process.exit(1);
  }
  const c = out.contracts['C.sol']['PlatformWallet'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// ---- test accounts (deterministic) ----
const KEYS = {
  ownerA: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  ownerB: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  attacker: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  liquidFlow: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
};
const wallets = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, new ethers.Wallet(v)]));
const ADDR = Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, w.address]));

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log('  PASS:', name); pass++; }
  else { console.log('  FAIL:', name); fail++; }
}

async function main() {
  const { abi, bytecode } = compile('src/PlatformWallet.sol');
  const iface = new ethers.Interface(abi);
  const vm = await VM.create({ common });

  // fund accounts
  const nonces = {};
  for (const a of Object.values(ADDR)) {
    const addr = new Address(hexToBytes(a));
    await vm.stateManager.putAccount(addr, undefined);
    const acct = await vm.stateManager.getAccount(addr) || (await import('@ethereumjs/util')).Account.fromAccountData({});
    acct.balance = 10n ** 20n; // 100 ETH each
    await vm.stateManager.putAccount(addr, acct);
    nonces[a] = 0n;
  }

  async function send(fromKey, to, data, value = 0n) {
    const from = ADDR[fromKey];
    const tx = LegacyTransaction.fromTxData({
      nonce: nonces[from]++, gasPrice: 10n, gasLimit: 5_000_000n,
      to: to ? new Address(hexToBytes(to)) : undefined,
      value, data: hexToBytes(data),
    }, { common }).sign(hexToBytes(KEYS[fromKey]));
    const res = await vm.runTx({ tx, skipBalance: true });
    return res;
  }

  async function callView(to, data) {
    const res = await vm.evm.runCall({
      to: new Address(hexToBytes(to)),
      caller: new Address(hexToBytes(ADDR.ownerA)),
      data: hexToBytes(data), gasLimit: 5_000_000n,
    });
    return bytesToHex(res.execResult.returnValue);
  }

  // ---- deploy with owners A,B and threshold 2 ----
  const deployData = bytecode + iface.encodeDeploy([[ADDR.ownerA, ADDR.ownerB], 2]).slice(2);
  const dep = await send('ownerA', null, deployData);
  const walletAddr = bytesToHex(dep.createdAddress.bytes);
  console.log('Deployed PlatformWallet at', walletAddr);
  console.log('  owners: A,B  threshold: 2  (Liquid Flow is NOT an owner)\n');

  // fund the wallet with 10 ETH (a "settlement")
  await send('liquidFlow', walletAddr, '0x', 10n ** 19n);
  let bal = (await vm.stateManager.getAccount(new Address(hexToBytes(walletAddr)))).balance;
  check('wallet received settlement (10 ETH)', bal === 10n ** 19n);

  console.log('\n--- GUARANTEE 1: Liquid Flow (non-owner) cannot propose a withdrawal ---');
  const wd = iface.encodeFunctionData('proposeWithdrawNative', [ADDR.liquidFlow, 10n ** 18n]);
  const r1 = await send('liquidFlow', walletAddr, wd);
  check('LF proposeWithdraw reverts (NotOwner)', r1.execResult.exceptionError !== undefined);

  console.log('\n--- GUARANTEE 2: an attacker cannot propose or execute ---');
  const r2 = await send('attacker', walletAddr, wd);
  check('attacker proposeWithdraw reverts', r2.execResult.exceptionError !== undefined);

  console.log('\n--- GUARANTEE 3: ONE owner alone cannot move funds (quorum = 2) ---');
  // ownerA proposes (auto-approves => 1 approval). Try to execute with only 1.
  const propA = await send('ownerA', walletAddr, iface.encodeFunctionData('proposeWithdrawNative', [ADDR.ownerA, 10n ** 18n]));
  check('ownerA can propose', propA.execResult.exceptionError === undefined);
  const execEarly = await send('ownerA', walletAddr, iface.encodeFunctionData('execute', [0]));
  check('execute with 1/2 approvals reverts (ThresholdNotMet)', execEarly.execResult.exceptionError !== undefined);

  console.log('\n--- GUARANTEE 4: with 2 distinct owner approvals, funds move (to builder-chosen dest) ---');
  await send('ownerB', walletAddr, iface.encodeFunctionData('approve', [0]));
  const balBefore = (await vm.stateManager.getAccount(new Address(hexToBytes(ADDR.ownerA)))).balance;
  const execOk = await send('liquidFlow', walletAddr, iface.encodeFunctionData('execute', [0])); // anyone can trigger
  check('execute with 2/2 approvals succeeds', execOk.execResult.exceptionError === undefined);
  const balAfter = (await vm.stateManager.getAccount(new Address(hexToBytes(ADDR.ownerA)))).balance;
  check('1 ETH delivered to builder-chosen destination', balAfter - balBefore === 10n ** 18n);

  console.log('\n--- GUARANTEE 5: same approved proposal cannot be replayed ---');
  const replay = await send('ownerA', walletAddr, iface.encodeFunctionData('execute', [0]));
  check('re-executing reverts (AlreadyExecuted)', replay.execResult.exceptionError !== undefined);

  console.log('\n--- GUARANTEE 6: an owner cannot approve twice to fake a quorum ---');
  await send('ownerA', walletAddr, iface.encodeFunctionData('proposeWithdrawNative', [ADDR.ownerA, 10n ** 18n])); // id 1, A=1
  const dbl = await send('ownerA', walletAddr, iface.encodeFunctionData('approve', [1]));
  check('owner approving twice reverts (AlreadyApproved)', dbl.execResult.exceptionError !== undefined);
  const execDbl = await send('ownerA', walletAddr, iface.encodeFunctionData('execute', [1]));
  check('still cannot execute with only 1 real approval', execDbl.execResult.exceptionError !== undefined);

  console.log('\n--- GUARANTEE 7: builder can sweep everything to an external wallet ---');
  // ownerA proposes sweep to an external address (attacker addr used purely as an
  // arbitrary "builder-chosen external wallet" here), ownerB approves, execute.
  const ext = ADDR.attacker;
  await send('ownerA', walletAddr, iface.encodeFunctionData('proposeSweepNative', [ext])); // id 2
  await send('ownerB', walletAddr, iface.encodeFunctionData('approve', [2]));
  const extBefore = (await vm.stateManager.getAccount(new Address(hexToBytes(ext)))).balance;
  await send('ownerA', walletAddr, iface.encodeFunctionData('execute', [2]));
  const walletBalEnd = (await vm.stateManager.getAccount(new Address(hexToBytes(walletAddr)))).balance;
  const extAfter = (await vm.stateManager.getAccount(new Address(hexToBytes(ext)))).balance;
  check('sweep empties the wallet', walletBalEnd === 0n);
  check('swept funds arrive at builder-chosen external wallet', extAfter > extBefore);

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
