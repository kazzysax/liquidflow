const fs = require('fs');
const path = require('path');
const solc = require('solc');

const file = process.argv[2] || 'src/PlatformWallet.sol';
const source = fs.readFileSync(file, 'utf8');
const name = path.basename(file);

const input = {
  language: 'Solidity',
  sources: { [name]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));

let hadError = false;
if (out.errors) {
  for (const e of out.errors) {
    console.log(`[${e.severity}] ${e.formattedMessage}`);
    if (e.severity === 'error') hadError = true;
  }
}
if (hadError) {
  console.log('COMPILE FAILED');
  process.exit(1);
}
const contracts = out.contracts[name];
for (const c of Object.keys(contracts)) {
  const bc = contracts[c].evm.bytecode.object;
  console.log(`OK ${c}: bytecode ${bc.length / 2} bytes`);
}
console.log('COMPILE OK');
