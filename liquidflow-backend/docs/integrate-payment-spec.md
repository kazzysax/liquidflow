# Liquid Flow — Integrate Payment System
## Architecture Specification (living document)

**Status:** draft · updated as the model evolves
**Scope:** the merchant-integrable crypto payment gateway ("PayFlow") within Liquid Flow.

---

## 1. Purpose

A payment gateway that third-party platforms ("builders") integrate to accept
crypto payments — secure, fast, and **non-custodial**. Liquid Flow coordinates
timing, routing, and tracking; it never holds platform or payer funds and never
has the unilateral ability to move them.

---

## 2. Actors

| Actor | Who | Does |
|---|---|---|
| **Builder** | Platform/merchant owner | Integrates PayFlow, configures it once, owns the platform wallet. |
| **Payer** | End user on the builder's platform | Pays for a plan in crypto. |
| **Liquid Flow** | Us | Coordinates: generates portals, matches deposits, routes swaps, fires webhooks, schedules payroll. **Holds no keys to funds.** |

---

## 3. The inviolable principle

**Liquid Flow's keys are timing/authorization keys, never money keys.**
At every layer, funds can only move to destinations the *builder* fixed in
advance. Liquid Flow can trigger *when* something happens, never *whether funds
go somewhere it chose*. If a design ever lets Liquid Flow redirect or withdraw
funds, that design is wrong and must be revised.

---

## 4. Builder onboarding (configuration)

When a builder selects "Integrate Payment System," they complete a config
questionnaire. Output: an **API key** + an **embeddable payment portal**.

Configuration captured:

1. **Chains** — choose specific chains or "multi-chain" (accept all supported).
2. **Settlement currency** — what the builder wants to keep (e.g. USDC).
3. **Liquidity unification** — on/off. If on, any incoming asset on any chain is
   swapped to the settlement currency and unified to the platform wallet.
4. **DEX aggregator** — which public aggregator performs swaps (e.g. 1inch, 0x,
   Jupiter on Solana). Builder's choice; swaps run through the public aggregator,
   not through Liquid Flow holding/trading funds.
5. **Plans** — see §8.
6. **Payout / external wallet** — address the builder can sweep unified liquidity to.
7. **Webhook URL** — where "payment confirmed → release service" signals are sent.

---

## 5. The platform wallet

Each platform gets its own wallet, shown on its portfolio/dashboard. Crucially:

- It is a **smart-contract account the builder owns** — not an address Liquid
  Flow holds keys to.
- Funds land here (after unification/swap if enabled).
- **Withdrawals require two-way authentication** (2-of-N approvals) enforced
  **on-chain by the contract**, not by Liquid Flow's server. Liquid Flow may be
  one *optional* configurable factor, but the builder always holds ultimate control.
- The builder can, at will, **sweep all liquidity to an external wallet** they
  provide. Non-custodial means they are never locked in.

---

## 6. The payer flow (every gateway)

1. Payer clicks "pay" on an integrated platform.
2. Portal shows the plan amount and asks which chain; payer selects.
3. Payer clicks "Make Payment" → a **payment reference** is shown: deposit
   address + a unique payment id (and QR). See §7 for why this is a reference,
   not a brand-new wallet.
4. Payer copies the address and sends the crypto.
5. Liquid Flow **detects the deposit and matches it** to the platform + payment id.
6. If unification is on: the asset is **swapped via the builder's chosen
   aggregator** and unified to the settlement currency.
7. Funds **settle to the platform wallet** (builder-owned).
8. Liquid Flow fires the **webhook** to the platform ("payment confirmed") so the
   platform releases the code / plan / service.
9. Payer sees a **confirmation page**.

---

## 7. Deposit tracking model (decided: per-payment reference)

**Decision: Option 1 — one gate contract per platform + a unique `paymentId` per payment.**

Rationale (three options were compared):

- **Per-payment reference (chosen):** same platform address, unique id per
  payment. Cheapest, cleanly trackable per-platform and per-payment, **no keys
  held by Liquid Flow.** The UI still shows a unique reference/QR per payment, so
  it *feels* like a fresh payment to the user.
- *HD-derived address each payment:* unique address per payment, but the master
  key would have to belong to the builder to avoid custody — more complex.
- *Brand-new keypair each payment:* maximum separation but operationally heavy
  (thousands of wallets) and custodial if Liquid Flow generates the keys.

**Generating addresses "as load increases"** is handled by deploying additional
platform gate contracts when needed; concurrency is handled by the per-payment
id, not by minting wallets.

---

## 8. Plans

Two plan tiers, each with monthly and yearly pricing:

| Plan | Monthly | Yearly |
|---|---|---|
| Plan 1 | $10 | $100 |
| Plan 2 | $18 | $180 |

(Display amounts; settled in the builder's chosen currency at payment time.)

---

## 9. Automatic payroll (decided: funded scheduler contract)

**Decision: a funded, cancellable payroll scheduler contract** — not raw
pre-signed transactions.

How it works:

- The company funds and configures a **payroll contract** with a schedule
  (employee addresses, amounts, release dates).
- Liquid Flow **watches the clock** and, on the release date, **triggers** the
  contract to release to employees. Liquid Flow only triggers timing; the
  contract's own rules authorize the payout.
- The company can **cancel or modify** any scheduled payout **until release** —
  the "pull the plug" guarantee.

Why not raw pre-signed transactions: they are hard to cancel, have fragile nonce
management, and can't easily be modified once signed. The funded contract keeps
the company in control and stays non-custodial (Liquid Flow never signs for the
company's money).

---

## 10. Liquidity unification (the highest-care area)

When enabled, incoming crypto on any chain is swapped to the settlement currency
via the builder's chosen public DEX aggregator and unified to the platform wallet.

**Honest risk note:** unification with auto-swap is the **least non-custodial**
part of the system, because something must route funds through the swap. We
minimize custody by using **atomic, contract-to-contract swaps** so funds never
"rest" with Liquid Flow. This is the piece where custody and regulatory exposure
concentrate; design it carefully and confirm with counsel before launch.

---

## 11. The native vs. token vs. non-EVM gate reality (carried from prior model)

- **Native coins (ETH, etc.):** the gate contract can truly **reject** deposits
  when closed (revert on receive). Full on-chain gate.
- **ERC-20 stablecoins (USDC/USDT):** the contract **cannot** reject an inbound
  token transfer (ERC-20 doesn't call the recipient on receive). Here the gate is
  an **accounting gate** — detect the deposit, credit only if a matching payment
  was opened, otherwise flag for **refund**.
- **Non-EVM (Solana, etc.):** also an accounting gate; address-level inflow
  rejection is not a chain primitive.

"Money arrived at a closed gate" (no matching open payment) is a **first-class
feature**, not an edge case: it must be detected and auto-refunded per rules.

---

## 12. Non-custodial design summary

1. Platform wallet = builder-owned smart account; 2-of-N withdrawal enforced on-chain.
2. Payroll = funded scheduler contract, cancellable until release.
3. Swaps via the builder's chosen public aggregator, contract-to-contract.
4. Per-payment `paymentId` instead of generating keypairs.
5. Liquid Flow keys are timing/authorization only, never money keys.
6. Builder can always exit — sweep everything to their own external wallet at will.

---

## 13. Open items / to confirm with counsel

- Liquidity unification touches funds-flow most directly → money-transmission
  analysis in target jurisdictions.
- Merchant AML/KYC obligations even under a non-custodial model.
- Travel-rule applicability on cross-party transfers above thresholds.
- Refund handling for deposits to closed/expired gates (consumer-protection angle).

---

## 14. Security & fund protection (the top-5 hardening features)

These address the most common payment-system failure modes. Status is marked
honestly: BUILT+TESTED (on-chain, verified), or SPEC (designed, builds with the
chain-watching/API layer).

### 14.1 Auto-refund + finality-aware settlement — SPEC
Solves the two most common real-world failures: funds lost to wrong
amount/chain/closed gate, and merchants burned by reorgs.
- **Auto-refund:** a deposit with no matching open payment (closed/expired gate,
  wrong amount, unsupported token) is detected and returned to sender per rules.
  Underpayment → credit partial + request difference; overpayment → refund excess.
- **Finality-aware settlement:** each chain has a configurable confirmation
  threshold. The webhook distinguishes `seen` from `final` (N confs). "Release
  service" fires only on `final` unless the merchant opts into faster, riskier
  settlement. Prevents reorg double-spends.

### 14.2 On-chain fund protection — BUILT + TESTED (SecurePlatformWallet.sol)
Verified against a real EVM (15/15 tests). Defense-in-depth so funds are hard to
drain even if owner keys leak:
- **Quorum (2-of-N)** to move anything.
- **Withdrawal allowlist** — funds can only go to pre-approved destinations.
- **Allowlist time-delay** — adding a new destination waits `allowlistDelay`;
  owners or a guardian can cancel during the window (defeats "thief adds their
  own address and drains").
- **Time-lock on large withdrawals** — transfers ≥ `largeAmount` wait
  `withdrawDelay` after quorum before executing.
- **Velocity limit** — rolling 24h cap (`dailyLimit`) on value out.
- **Circuit breaker** — any owner or the guardian can pause instantly; unpausing
  requires full quorum (a single compromised key cannot un-pause).
- **Guardian role** — can pause and cancel pending allowlist adds, but can NEVER
  move funds. A safety role, not a money role.

### 14.3 Gas abstraction (sponsored / pay-in-token) — SPEC
Solves the biggest payer drop-off ("I don't have ETH for gas"). ERC-4337
paymaster lets payers pay fees in the token they're sending, or the merchant
sponsors gas.

### 14.4 Signed receipts + on-chain proof of payment — SPEC
Solves "I paid but got nothing." Every payment yields a signed receipt verifiable
against the append-only ledger + on-chain tx; idempotent webhooks with retry +
backoff; release signal bound to the confirmed on-chain payment, not one fragile
server event.

### 14.5 Volatility protection via unification — SPEC (ties to §10)
Solves "merchant paid, value dropped before cash-out." Incoming crypto is swapped
to the settlement stablecoin at payment time, locking value.

### Dashboard withdrawal authentication (non-custodial multi-factor)
Multiple auth steps (email, passkey, passcode, authenticator) can gate
withdrawals WITHOUT becoming custodial — provided each factor gates the USER's own
signing power, never a Liquid Flow key:
- **Passkey as an on-chain signer** (WebAuthn) — device-bound; LF never holds it.
- **Multi-factor = multi-signer** on the smart account; enforced on-chain.
- **Email/TOTP** gate an MPC key-share the *user* controls — never a LF master key.
- **Litmus test:** if LF's servers were fully compromised, could an attacker move
  funds? Must be NO. (Email/TOTP are easiest to accidentally make custodial.)

---

## 15. Change log

- **v0.7** — Added payer↔merchant unlinking (`payments/unlink_demo.js`, 6/6 on real
  secp256k1). Closes the announcement leak: the ephemeral key R the merchant needs
  to find a payment is delivered PRIVATELY via the LF API, not a public announcer —
  so a merchant's payments can't be clustered on-chain. Proven: payments to one
  merchant yield mutually-unlinkable addresses; nothing on-chain reveals the
  merchant; an observer without R can't tie an address to the merchant; the merchant
  backend (view key + private R) still recognizes every payment. By DESIGN amounts
  stay VISIBLE (keeps confirmation/tracking/totals working and stays on the
  defensible regulatory side). HONEST BOUNDARY (tested explicitly): this unlinks the
  payment from the merchant; it CANNOT scrub the payer's own wallet history — true
  payer anonymity needs the payer to use a clean wallet, which LF can suggest but not
  enforce. Privacy posture chosen: strong-but-defensible (unlink yes, hide-amounts
  no). Maximum privacy (ZK amount-hiding, activity-hiding) deliberately NOT pursued
  due to AML/sanctions exposure — counsel-gated if ever revisited.
- **v0.6** — Added optional STEALTH/private deposit addresses for the payment flow
  (`payments/stealth_payment_demo.js`, 7/7 proven on real secp256k1). When enabled,
  each payer automatically gets a FRESH, unlinkable deposit address derived from the
  builder's published meta-address (public keys) + a random ephemeral key bound to
  the paymentId. Proven: builder publishes keys ONCE then takes no action; live
  derivation uses PUBLIC keys only (non-custodial — no fund-moving key in the live
  path); view key recognizes/totals payments but cannot spend; outsiders cannot link
  addresses to the platform (defeats balance-watching); only the builder's spend key
  sweeps, on their schedule. TRADE-OFF: private mode replaces the gate's instant-
  forward with scattered one-time receipt + later sweep (cannot both forward to one
  known address instantly AND keep it private). Payment system now offers two modes:
  (1) PaymentGate instant-forward (public, instant) and (2) stealth deposit (private,
  deferred sweep). Same stealth core as Potlock; non-EVM custom derivations +
  dedicated crypto audit caveats apply equally.
- **v0.5** — Adversarial self-audit of the EVM contracts. Wrote two attack suites
  (8 attacks on SecurePlatformWallet incl. a reentrancy contract; 13 deeper logic
  attacks across PaymentGate/PayrollScheduler/wallet edges) — all held. Critical
  code reading FOUND ONE REAL VULNERABILITY: stale unpause votes. Unpause votes
  were global and only cleared on success, so a leftover vote from an abandoned
  unpause cycle could carry into a later pause and let fewer than `threshold`
  fresh approvals unpause the wallet, defeating quorum-gated unpause. FIXED by
  scoping votes to a `pauseEpoch` (a fresh pause increments the epoch, abandoning
  prior-cycle votes). Recompiled; added a regression test reproducing the attack
  (5/5 pass) and re-ran every suite: 12+15+11+15 functional, 8+13 attacks secure,
  5 regression — 0 vulnerabilities remaining. NOTE: passing these tests is strong
  evidence, NOT a substitute for an independent professional audit.
- **v0.4** — Built `PaymentGate.sol` (11/11) and `PayrollScheduler.sol` (15/15),
  both compiled and EVM-verified.
- **v0.3** — Built `SecurePlatformWallet.sol` (15/15); §14 security model.
- **v0.2** — Built `PlatformWallet.sol` (12/12).
- **v0.1** — initial model: actors, flows, tracking, payroll, pricing, diagrams.
