# LIQUID FLOW — MAKE IT LIVE (VS Code / Claude Code handoff)

This is the master instruction file. Open this whole folder in VS Code, start
Claude Code, and work through the phases below. Each phase has a **copy-paste
prompt** for Claude and a **"you should see"** check so you know it worked.

The reason this happens in VS Code and not where it was built: making it live needs
a real internet connection to blockchains, the Rust/Solana/Foundry toolchains, and a
deploy target — none of which existed in the build sandbox. Everything here is
written and the logic is proven; these steps compile it, connect it to real
testnets, and wire it together.

---

## WHAT YOU HAVE (already built + proven)

- **EVM contracts** (Solidity) — compiled + tested + adversarially attacked (native
  coin paths). `liquidflow-backend/contracts/`
- **Non-EVM contracts** (Solana/Aptos/Sui/NEAR) — written, not yet compiled.
- **Privacy crypto** — stealth addresses + payer↔merchant unlinking + receipts, all
  proven runnable. `liquidflow-backend/payments/`, `potlock/`, `receipts/`
- **Merchant API + webhooks** — runnable reference. `liquidflow-backend/api/`
- **Rust backend** — written, needs compiling. `liquidflow-backend/backend/`
- **Frontend** — all pages, on-brand, using demo data (need wiring). root `*.html`

## WHAT'S MISSING (what these steps build)

1. The **deposit-watcher** (the keystone — watches chains, confirms, fires webhooks).
2. Compiling + running the backend, with Postgres.
3. Deploying contracts to a testnet.
4. Wiring frontend → API → contracts.
5. The NEAR Intents swap path.

---

## PHASE 0 — Orient Claude (paste this first)

> "Read GO-LIVE.md, liquidflow-backend/VSCODE-TASKS.md, and
> liquidflow-backend/GO-LIVE-STATUS.md. Then read the contracts in
> liquidflow-backend/contracts/src, the proven crypto demos in
> liquidflow-backend/payments and potlock, and the API reference in
> liquidflow-backend/api/merchant_api_demo.js. Summarize the architecture back to me
> and confirm you understand that LF keys are timing/authorization keys, never
> fund-moving keys (non-custodial). Don't write code yet."

**You should see:** Claude correctly describes the two systems, the gate/wallet/
payroll contracts, the stealth privacy model, and the non-custodial principle.

---

## PHASE 1 — EVM contracts live on testnet

> "Install Foundry. Create a Foundry project that imports the four contracts in
> liquidflow-backend/contracts/src. Get `forge build` passing. Then write Foundry
> tests for the ERC-20 TOKEN paths (the existing JS tests only covered native coin):
> token withdrawals with the per-token velocity cap, and PaymentGate.settleToken,
> using a forked-mainnet USDC. Then deploy all four to Base Sepolia with a script and
> give me the explorer links. Exercise openPayment → pay → settle on testnet."

**You should see:** green `forge test`, four deployed addresses on sepolia.basescan.org,
and a successful test payment transaction.

**Get testnet funds first:** a wallet with Base Sepolia ETH (free from a faucet).
Claude will tell you where to paste your RPC URL and a test private key — USE A
THROWAWAY KEY, never a real-funds key.

---

## PHASE 2 — The backend running (deposit-watcher + API)

> "Compile and run liquidflow-backend/backend (resolve the alloy/sqlx notes in the
> code). Stand up Postgres via docker and run the migrations in backend/migrations.
> Then build the DEPOSIT-WATCHER: a service that connects to the Base Sepolia RPC,
> watches the deployed gate + stealth addresses, counts confirmations, matches each
> deposit to a paymentId, and fires the HMAC-signed webhook from
> api/merchant_api_demo.js. For stealth payments, recognize deposits with the
> merchant view key + privately-stored R (logic is in
> payments/stealth_payment_demo.js). Dedupe by tx hash, reject degenerate ephemeral
> keys. Turn api/merchant_api_demo.js into the real API endpoints."

**You should see:** backend boots, connects to the RPC, and when you send a testnet
payment to a gate address, the watcher logs it, confirms it, and fires a webhook.

**Note:** if compiling Rust is slow going, tell Claude: *"port the backend +
deposit-watcher to Node/TypeScript instead so it runs immediately with my installed
Node"* — same logic, no toolchain wait.

---

## PHASE 3 — Wire the frontend to the live backend

> "Wire integrate-setup.html to actually create a merchant + API key via the backend.
> Wire the payer payment flow to call POST /payments and show the returned deposit
> address (gate or stealth). Wire receipt-verify.html and potlock-private.html to the
> live API for real verification and real totals. Replace all demo data with live API
> calls."

**You should see:** completing the wizard creates a real merchant; a payer flow
returns a real deposit address; paying it on testnet flips the status to confirmed
and fires the webhook.

---

## PHASE 4 — NEAR Intents swap + non-EVM (optional for first testnet loop)

> "Implement the NEAR Intents settlement path for liquidity unification (the wizard
> already captures it as the sole provider). Verify against NEAR's current docs that
> it stays non-custodial. Separately: install the Solana/Aptos/Sui/NEAR toolchains and
> compile + test the four contracts in liquidflow-backend/contracts, porting the
> G1–G11 parity checks from NONEVM_README.md and the stealth attack suite."

**You should see:** a working swap on testnet; the four non-EVM contracts compiling
and passing their parity tests.

---

## PHASE 5 — BEFORE REAL MONEY (do not skip)

This makes it *testable end-to-end on testnet*. Before MAINNET with real funds:
1. Independent professional smart-contract audit (every contract, every chain).
2. Dedicated cryptographic audit of the stealth scheme (highest-risk piece).
3. Formal verification of the "no unauthorized fund movement" invariant.
4. Testnet bug bounty.
5. Legal/regulatory review — money transmission, AML/KYC, travel rule, and the
   privacy posture. Counsel signs off before mainnet.

---

## DEPLOYMENT TARGET (when you want it reachable on an IP/server)

To put the testnet product on a server you can reach by IP:
> "Write a docker-compose that runs Postgres + the backend + the deposit-watcher +
> serves the frontend, plus a deploy guide for a cheap Linux VM (e.g. a $5 cloud
> instance). Bind it to the server IP, set the testnet RPC URLs as env vars, and give
> me the exact commands to run on the VM."

**You should see:** `docker compose up` brings the whole stack live on the server;
you visit http://YOUR_SERVER_IP and click through the real product.

---

## GOLDEN RULES (tell Claude to honor these)

- **Non-custodial always.** LF keys can time/authorize but never move funds. If a
  step would require LF to hold a fund-moving key, stop and flag it.
- **Use throwaway keys on testnet.** Never paste a real-funds private key.
- **Test on testnet only** until Phase 5 is complete.
- **Don't claim "audited."** Tested ≠ audited. The Phase 5 gate is real.
- **The stealth crypto is the highest-risk component** — it needs a dedicated
  cryptographic audit before real funds, no exceptions.
