# Liquid Flow — Payment-System Problem Solvers

Implementation notes for the five most common payment-system failure modes.
Status is marked honestly per item.

---

## 1. Auto-refund for unmatched / wrong deposits — SPEC + rules

**Problem:** user sends the wrong amount, wrong chain, wrong token, or pays to a
closed/expired gate. Most systems silently lose these funds.

**Solution — refund state machine** (runs in the deposit-watcher):
- Every confirmed inbound deposit is matched against open payments for that
  platform by `payment_id` / expected amount / asset.
- **Matched, exact:** credit, settle, fire webhook.
- **Matched, underpaid:** credit partial; mark `awaiting_topup`; tell payer the
  remaining amount; refund if not topped up within the window.
- **Matched, overpaid:** credit the expected amount; auto-refund the excess.
- **Unmatched** (closed/expired gate, unknown reference, unsupported asset):
  auto-refund the full amount to the sender, minus network fee, per policy.
- Every refund is itself a tracked, receipted on-chain action (see §4).

Refund is a **first-class feature**, not an error path: "money at a closed gate
goes back" must be guaranteed and testable.

---

## 2. Finality-aware settlement (reorg protection) — SPEC

**Problem:** a transaction looks confirmed, the merchant ships, then a chain
reorg reverses it. Merchant is out the goods.

**Solution — per-chain confirmation thresholds + two-stage signal:**
- Each chain has a configured `min_confirmations` (high for low-security chains,
  low for fast-finality chains like Solana/Sui/Aptos/NEAR).
- The webhook fires **twice**: `seen` (in mempool / 1 conf — show "payment
  detected") and `final` (>= `min_confirmations` — "release the service").
- Merchants default to releasing on `final`; they may opt into `seen` for
  low-value/low-risk items, accepting the reorg risk explicitly.
- The receipt records `confirmations` and `final` so the proof reflects finality.

---

## 3. Gas abstraction (sponsored / pay-in-token) — SPEC

**Problem:** "I can't pay because I don't have the native coin for gas" is the
single biggest payer drop-off.

**Solution:**
- **EVM:** ERC-4337 account abstraction with a **paymaster**. The payer pays fees
  in the token they're sending, or the merchant sponsors gas. Removes the
  native-gas prerequisite.
- **Non-EVM:** use each chain's native fee-payer / fee-delegation feature where it
  exists (Solana fee-payer, Aptos sponsored transactions, Sui sponsored txns,
  NEAR meta-transactions / relayer).
- Liquid Flow can act as the relayer/sponsor and bill the merchant — this is a
  service role, not custody (it never gains the ability to move user funds).

---

## 4. Signed receipts + on-chain proof (anti-forgery) — BUILT + TESTED (demo)

**Problem:** "I paid but got nothing," plus forged receipts ("proof" someone
paid when they didn't, or for more than they did).

**Solution — two independent sources of truth; a receipt is valid only if BOTH
hold:**

1. **The blockchain.** The receipt carries the real `tx_hash` and a clickable
   **block-explorer URL** (Etherscan/Basescan/Solscan/Aptos/Suiscan/Nearblocks/…).
   Anyone can independently confirm the payment exists with the stated amount to
   the stated merchant address. A forger cannot invent a tx hash that resolves to
   a matching real transaction.
2. **An Ed25519 signature** by Liquid Flow's receipt key over the canonical
   receipt bytes. Changing any field breaks the signature; a forger without the
   private key cannot produce a valid one.

**Acceptance rule:** `signature verifies` AND `on-chain tx matches (amount,
destination, asset, >= min_confirmations)`. Signature alone is necessary but not
sufficient — the chain is the final arbiter.

**Why this is robust even if the signing key leaks:** the receipt key signs
receipts only and can NEVER move funds (non-custodial is unaffected). A leaked key
lets an attacker mint *false* receipts — but the on-chain check (source #1)
immediately exposes them, because no matching transaction exists. So forgery
requires breaking the chain (infeasible) AND faking the signature (needs the key):
two independent barriers.

**Anti-forgery hardening included:**
- **Canonical serialization** (fixed field order) so key-reordering can't be
  exploited and client re-serialization can't change the verdict.
- **Pinned verifier key** — verifiers trust Liquid Flow's known public key, NOT
  the key embedded in the receipt (otherwise a forger could ship their own key).
- **Explorer link** lets any human do a zero-trust check by eye.

**Status:** proven by a runnable demo (`receipts/demo/receipt_demo.js`, 6/6
checks pass against real Ed25519): genuine verifies; tampered amount / tx_hash /
merchant address all fail; forger's own-key signature fails; key reordering is
handled. Production module in Rust: `backend/src/receipts.rs` (dual-source
`verify_receipt`, explorer URLs, unit tests including the leaked-key → ChainMismatch
case). Rust not sandbox-compiled (toolchain blocked); JS demo IS executed.

---

## 5. Volatility protection via unification — SPEC (ties to platform wallet)

**Problem:** merchant gets paid, the asset's value drops before they cash out.

**Solution:** when the builder enables unification, incoming crypto is swapped to
the settlement stablecoin (e.g. USDC) **at payment time** via the builder's chosen
DEX aggregator, locking the value immediately. Swaps are atomic / contract-to-
contract so funds never rest with Liquid Flow (minimizing the one custody-risk
area). The settled stablecoin lands in the builder-owned platform wallet.

---

## Honest status summary

| # | Feature | Status |
|---|---|---|
| 1 | Auto-refund / under-overpayment | SPEC + rules (needs deposit-watcher) |
| 2 | Finality-aware settlement | SPEC (needs deposit-watcher) |
| 3 | Gas abstraction | SPEC (needs 4337 / per-chain relayer) |
| 4 | Signed receipts + on-chain proof | BUILT: JS demo executed (6/6); Rust module written + unit-tested (not sandbox-compiled) |
| 5 | Volatility protection | SPEC (ties to unification + platform wallet) |

The deposit-watcher / chain-interaction layer is the shared dependency that turns
1, 2, and the chain-side of 4 into running code. That is the natural next build.
