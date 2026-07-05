# Liquid Flow — Complete Package

Non-custodial multi-chain crypto payment platform. Two systems: **Integrate
Payment** (a gateway other platforms embed) and **Potlock** (private fundraising
with stealth addresses).

## START HERE
1. **GO-LIVE.md** — the master VS Code instructions to make this live on testnet.
   Open this folder in VS Code, start Claude Code, paste the Phase 0 prompt.
2. **liquidflow-backend/VSCODE-TASKS.md** — the detailed phase-by-phase task list.
3. **liquidflow-backend/GO-LIVE-STATUS.md** — honest status of what's done vs not.

## RUN THE PROOFS NOW (Node + browser, no toolchains)
- Open the `*.html` files in a browser (start with `index.html`).
- `node liquidflow-backend/potlock/stealth_demo.js` (and the other demos in
  payments/, potlock/, receipts/, api/) — proven crypto + API flows.
- EVM contract tests: `cd liquidflow-backend/contracts`, install the deps listed in
  VSCODE-TASKS.md, then `node test/<name>.test.js`.

## FOLDER MAP
- `*.html` — frontend (landing, gateway, onboarding wizard, potlock, receipt verify)
- `liquidflow-backend/contracts/` — EVM (Solidity, tested) + non-EVM (review-grade)
- `liquidflow-backend/payments/` `potlock/` `receipts/` — proven privacy crypto
- `liquidflow-backend/api/` — merchant API + webhooks reference
- `liquidflow-backend/backend/` — Rust backend (to compile in VS Code)
- `liquidflow-backend/docs/` — full design specs + audit + checkup

## NON-CUSTODIAL PRINCIPLE
Liquid Flow keys can time and authorize actions but can NEVER move funds. If LF's
servers were fully compromised, an attacker still could not move user money. Every
build step must preserve this.

## HONEST STATUS
Logic + crypto + EVM contracts are proven where runnable. NOT yet built: the live
runtime (deposit-watcher, running backend, wiring). NOT yet done: token-path tests,
non-EVM compilation, professional audit, counsel review. NOT mainnet-ready — testnet
is the next step (see GO-LIVE.md).
