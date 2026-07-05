# Liquid Flow — VS Code Task List (run these with Claude Code)

Everything below needs a real environment (live RPCs, toolchains, deployment) that
the authoring sandbox could not provide. Do these in VS Code with Claude Code.
Ordered so each step builds on the last. Copy a task block to Claude in VS Code.

---

## PHASE 1 — EVM contracts to testnet (start here, highest value)

### Task 1.1 — Set up Foundry and import contracts
> "Install Foundry. Create a Foundry project. Import the four contracts from
> `liquidflow-backend/contracts/src/` (PlatformWallet, SecurePlatformWallet,
> PaymentGate, PayrollScheduler). Get them compiling with `forge build`."

### Task 1.2 — Close the #1 gap: ERC-20 token-path tests
> "The existing JS tests only exercised NATIVE coin. Write Foundry tests that
> exercise the ERC-20 / token paths against a real mock ERC-20 AND a forked-mainnet
> USDC: token withdrawals from SecurePlatformWallet (incl. the per-token velocity
> cap `setTokenLimitTighten`), and PaymentGate.settleToken. Confirm funds only ever
> reach the merchant and the velocity cap holds."

### Task 1.3 — Port the attack + regression suites
> "Port the adversarial tests from `contracts/test/attack_*.js` and
> `regression_unpause.test.js` into Foundry so they run in CI. Add fuzz tests
> (forge's property testing) for the quorum and velocity invariants."

### Task 1.4 — Deploy to testnet
> "Deploy all four contracts to Base Sepolia (and Sepolia). Write a deploy script.
> Exercise a full PaymentGate flow on testnet: openPayment → pay → confirm funds
> reached the merchant → events emitted. Give me the explorer links."

---

## PHASE 2 — Non-EVM contracts (your stealth/multichain track)

### Task 2.1 — Solana
> "Install Rust + Solana CLI + Anchor. Build `contracts/solana` with `anchor build`.
> Write Anchor tests asserting the G1–G11 guarantees from `contracts/NONEVM_README.md`.
> Run against a local validator, then deploy to devnet."

### Task 2.2 — Aptos, Sui, NEAR
> "For each of `contracts/aptos`, `contracts/sui`, `contracts/near`: install the
> toolchain, compile, and write tests covering G1–G11 (the parity checklist in
> NONEVM_README.md). Deploy each to its testnet. Flag any compile issues."

### Task 2.3 — Non-EVM stealth derivations (HIGH RISK — get audited)
> "Implement the ed25519 stealth-address derivation for Solana/Aptos/Sui/NEAR,
> matching the secp256k1 scheme proven in `payments/stealth_payment_demo.js` and
> `potlock/stealth_demo.js`. Port the attack suite `potlock/attack_stealth.js` to
> each. NOTE: this is custom privacy crypto — flag it for a dedicated cryptographic
> audit, do not ship without one."

---

## PHASE 3 — Backend services (the missing runtime)

### Task 3.1 — Compile the Rust backend
> "Compile `liquidflow-backend/backend`. Resolve the inline notes about the alloy
> signature-recovery API and sqlx. Stand up Postgres, run the migrations in
> `backend/migrations/`, and confirm the append-only ledger invariants test passes."

### Task 3.2 — Build the deposit-watcher (the keystone)
> "Build a deposit-watcher service: connect to testnet RPCs for each configured
> chain, watch for deposits to gate addresses AND stealth addresses, count
> confirmations to a per-chain threshold, match each deposit to a paymentId, and on
> finality call the webhook. For stealth payments, use the merchant's view key +
> the privately-stored R to recognize deposits (logic proven in
> `payments/stealth_payment_demo.js`). Dedupe by tx hash, not address (see the
> attack_stealth finding). Reject degenerate ephemeral keys."

### Task 3.3 — Merchant API + webhooks
> "Turn `api/merchant_api_demo.js` into the production API in Rust/Axum: POST
> /payments, GET /payments/:id, the private R channel, and HMAC-signed webhooks with
> retry + backoff. Match the signing scheme in the demo so merchants can verify."

### Task 3.4 — View-key scanner (totals)
> "Build the view-key scanner that computes running totals for Potlock campaigns and
> private-payment merchants from recognized stealth deposits — for the public
> progress curve and the merchant dashboard."

---

## PHASE 4 — Integration + DEX

### Task 4.1 — NEAR Intents swap path (liquidity unification)
> "Implement the unify-liquidity swap: when a merchant has unify ON, route incoming
> assets through NEAR Intents to the
> settlement currency, contract-to-contract so funds never rest with us. The wizard
> already captures the choice (`integrate-setup.html`)."

### Task 4.2 — Wire frontend → API → contracts
> "Wire the onboarding wizard (`integrate-setup.html`) to actually create a merchant
> + API key via the backend. Wire the payer flow and receipt-verify dashboard to the
> live API. Test the full loop on testnet in BOTH instant and stealth modes."

---

## PHASE 5 — Pre-mainnet gate (NON-NEGOTIABLE before real funds)

1. **Independent professional smart-contract audit** — every contract, every chain.
2. **Dedicated cryptographic audit** of the stealth scheme (highest-risk component).
3. **Formal verification** of the "no unauthorized fund movement" invariant.
4. **Testnet bug bounty.**
5. **Legal/regulatory review** — money transmission, AML/KYC, travel rule, and the
   privacy posture specifically. Counsel must sign off before mainnet.

---

## Quick reference — what's already proven (don't redo, just wire up)

- EVM contracts: compiled + 51 functional + 26 adversarial tests pass (native coin).
- Stealth crypto (secp256k1): payment derivation 7/7, unlinking 6/6, potlock 6/6,
  attacks 7/7 — all proven in `payments/` and `potlock/`.
- Receipts (Ed25519): anti-forgery 6/6.
- Merchant API flows: create/status/webhook/private-R proven in `api/merchant_api_demo.js`.
- Onboarding wizard: `integrate-setup.html` (chains, settlement, DEX, unify, privacy,
  plans, payout, webhook) — UI done, needs backend wiring.

The crypto and contract LOGIC is proven. Phases 1–4 are about running it for real;
Phase 5 is the gate to mainnet.
