// Node/ethers deploy of the 4 LF contracts to Base Sepolia using the
// pre-compiled artifacts in out/. No Foundry required.
//
//   node deploy.js
//
// Reads the throwaway deployer key from ~/.lf_deployer.json (address must be
// funded with Base Sepolia ETH from a faucet first).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ethers } = require('ethers');

// Network selectable via NETWORK env: base-sepolia | eth-sepolia (default).
const NETWORKS = {
  'base-sepolia': {
    rpc: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org/address/',
    chain: 'eip155:84532',
  },
  'eth-sepolia': {
    rpc: process.env.ETHEREUM_SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io/address/',
    chain: 'eip155:11155111',
  },
};
const NET = NETWORKS[process.env.NETWORK || 'eth-sepolia'];
const RPC = NET.rpc;
const EXPLORER = NET.explorer;

function artifact(name) {
  const j = require(path.join(__dirname, 'out', `${name}.sol`, `${name}.json`));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function main() {
  const keyPath = path.join(os.homedir(), '.lf_deployer.json');
  const { privateKey, address } = JSON.parse(fs.readFileSync(keyPath, 'utf8'));

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(privateKey, provider);
  const me = wallet.address;

  const net = await provider.getNetwork();
  const bal = await provider.getBalance(me);
  console.log(`Deployer:  ${me}`);
  console.log(`Network:   chainId ${net.chainId} (${RPC})`);
  console.log(`Balance:   ${ethers.formatEther(bal)} ETH`);
  if (bal === 0n) {
    console.error('\n❌ Deployer has 0 ETH. Fund it from a Base Sepolia faucet first:');
    console.error('   https://www.alchemy.com/faucets/base-sepolia  (or coinbase / quicknode)');
    console.error(`   Address: ${me}`);
    process.exit(1);
  }

  const ONE = ethers.parseEther('1');
  const TEN = ethers.parseEther('10');

  // [name, constructor args]  — testnet params; operator/trigger/guardian act as
  // the LF authorization key (can time/authorize, never move funds).
  const plan = [
    ['PaymentGate',          [me, me]],
    ['PlatformWallet',       [[me], 1]],
    ['SecurePlatformWallet', [[me], 1, me, 0, ONE, 0, TEN]],
    ['PayrollScheduler',     [me, me]],
  ];

  const deployed = {};
  for (const [name, args] of plan) {
    process.stdout.write(`Deploying ${name} ... `);
    const { abi, bytecode } = artifact(name);
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    const c = await factory.deploy(...args);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    deployed[name] = addr;
    console.log(`${addr}`);
    console.log(`   ${EXPLORER}${addr}`);
  }

  const netName = process.env.NETWORK || 'eth-sepolia';
  const out = {
    chain: NET.chain,
    network: netName,
    deployer: me,
    deployedAt: new Date().toISOString(),
    contracts: deployed,
  };
  const outFile = `deployed-${netName}.json`;
  fs.writeFileSync(path.join(__dirname, outFile), JSON.stringify(out, null, 2));
  console.log(`\n✅ All 4 deployed. Saved → ${outFile}`);
}

main().catch((e) => { console.error('deploy failed:', e.message || e); process.exit(1); });
