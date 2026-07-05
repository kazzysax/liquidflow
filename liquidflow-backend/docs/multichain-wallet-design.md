# Liquid Flow — Multi-Chain Platform Wallet
## Design Specification: EVM + Solana + Aptos + Sui + NEAR

**Status:** design (pre-build) · companion to `integrate-payment-spec.md`
**Goal:** the builder-owned, non-custodial platform wallet — with full security
parity — on every supported chain.

---

## 1. Why this doc exists

The platform wallet is built and EVM-verified (`PlatformWallet.sol`,
`SecurePlatformWallet.sol`). EVM contracts run unchanged across all EVM chains
(Ethereum, Base, Polygon, Arbitrum, Optimism, BNB, Avalanche). The four non-EVM
chains in scope — **Solana, Aptos, Sui, NEAR** — each need a *native*
implementation in that chain's language and execution model. They share nothing
with Solidity but the guarantees.

This doc locks the shared guarantee model once, then specifies how each chain
enforces it, so the four ports stay behaviorally identical.

---

## 2. The shared guarantee model (identical on every chain)

Every port MUST enforce, on-chain, all of the following. These are the acceptance
criteria; a port is not "done" until each is tested on that chain.

| # | Guarantee | EVM mechanism (reference) |
|---|---|---|
| G1 | Builder owns the wallet; Liquid Flow is never an owner | owner-set mapping |
| G2 | Moving funds needs a quorum (2-of-N) | `threshold` + approvals |
| G3 | Liquid Flow can NEVER move funds | LF not in owner-set; no admin role |
| G4 | Builder can sweep everything to an external address | `proposeSweep*` |
| G5 | Withdrawal allowlist (funds only to pre-approved dests) | `allowedAt` mapping |
| G6 | New allowlist entries are time-delayed + cancellable | `allowlistDelay`, guardian cancel |
| G7 | Large withdrawals are time-locked | `withdrawDelay`, `readyAt` |
| G8 | Rolling 24h velocity cap on outflow | `dailyLimit`, window |
| G9 | Circuit breaker: instant pause, quorum unpause | `pause` / `approveUnpause` |
| G10 | Guardian can pause + cancel allowlist, never move funds | `guardian` role |
| G11 | No replay; no double-approve; reentrancy-safe | `executed`, `approved`, guard |

**The litmus test for every port:** if Liquid Flow's servers were fully
compromised, could an attacker move a user's funds? Must be **NO** on every chain.

---

## 3. Programming-model differences (why this is 3 distinct builds, not 1)

| Chain | Language | Toolchain | State model | Multisig primitive |
|---|---|---|---|---|
| Solana | Rust | Anchor | Accounts (state in separate accounts) | SPL/Squads or custom PDA |
| Aptos | Move | Aptos CLI | Resources under accounts | custom (resource-guarded) |
| Sui | Move (Sui dialect) | Sui CLI | Objects (owned/shared) | custom (shared object) |
| NEAR | Rust → WASM | near-sdk | Account contracts | custom (state in contract) |

Aptos and Sui share the Move *language* but not the *model*: Aptos stores
resources under account addresses; Sui treats everything as objects with explicit
ownership. The wallet is a *shared object* on Sui vs a *resource* on Aptos — the
code is materially different.

---

## 4. Solana port (Rust / Anchor)

**Model.** The wallet is a program-derived account (PDA) holding config (owners,
threshold, security params) plus separate accounts for proposals. SOL and SPL
tokens are held in PDA-owned token accounts.

**Guarantee mapping:**
- G1/G3: owner pubkeys stored in the wallet PDA; Liquid Flow's key is never added.
  No `admin`/`upgrade-authority` that can move funds (program upgrade authority, if
  retained, must be a builder/guardian multisig or burned — see Risks).
- G2: a `Proposal` account accumulates approvals from distinct owner signers;
  `execute` checks `approvals >= threshold`.
- G4: sweep instruction transfers full PDA balance to an allowlisted dest.
- G5/G6: an `Allowlist` account per destination with `active_at` slot/clock;
  `activate` requires `Clock` past `active_at`; guardian may close it while pending.
- G7: proposal stores `ready_at` (Clock); `execute` requires `Clock >= ready_at`.
- G8: rolling window fields in the wallet PDA; checked on execute (lamports).
- G9: `paused` flag; `pause` callable by any owner or guardian; `unpause` needs quorum.
- G10: guardian pubkey; can pause/cancel-allowlist, never appears in approval count.
- G11: Anchor's account constraints + a `executed` flag prevent replay; Solana's
  single-threaded per-account execution avoids reentrancy, but CPI ordering still
  follows checks-effects-interactions.

**Solana-specific risks:** the program **upgrade authority** is the real backdoor
on Solana — whoever holds it can replace the program logic. It MUST be a
builder/guardian multisig or burned; if Liquid Flow held it, the whole
non-custodial claim collapses regardless of the instruction logic.

---

## 5. Aptos port (Move)

**Model.** A `Wallet` resource stored under the builder's account (or a dedicated
resource account), holding owners, threshold, security params. Coins held as
`Coin<T>` resources; proposals as a table of `Proposal` structs.

**Guarantee mapping:**
- G1/G3: owners vector in the `Wallet` resource; LF address never added. Move has
  no hidden admin; resource ownership is explicit.
- G2: `approve` records distinct signer addresses; `execute` checks quorum.
- G4: sweep withdraws the full `Coin<T>` balance to an allowlisted address.
- G5/G6: `allowlist` table with `active_at` timestamp; `activate` checks
  `timestamp::now_seconds() >= active_at`; guardian can remove while pending.
- G7: proposal `ready_at`; `execute` checks timestamp.
- G8: rolling-window fields; checked on execute.
- G9: `paused` bool; pause by owner/guardian; unpause quorum-gated.
- G10: guardian address; pause/cancel only.
- G11: Move's resource safety means coins can't be copied or silently dropped —
  a strong native guarantee. `executed` flag prevents replay; no reentrancy in Move.

**Aptos strength:** resources *cannot* be duplicated or accidentally lost — the
type system enforces conservation of funds at compile time. This is a safety
property EVM lacks.

---

## 6. Sui port (Move, Sui dialect)

**Model.** The wallet is a **shared object** (so multiple owners can interact);
balances held as `Coin<T>` objects owned by the wallet object. Proposals are
fields/dynamic-object-fields on the wallet.

**Guarantee mapping:**
- G1/G3: owners stored in the shared wallet object; LF never added. Sui object
  ownership is explicit; no admin capability is minted to Liquid Flow.
- G2: approvals tracked in the object; `execute` checks quorum.
- G4: sweep transfers the wallet's `Coin<T>` to an allowlisted address.
- G5–G9: allowlist table, `ready_at`, velocity window, `paused` — all as fields on
  the shared object; Sui's `Clock` object provides time.
- G10: guardian address field; pause/cancel only.
- G11: Sui's object model + a `executed` flag prevent replay; capability-based
  access (no ambient authority) is a strong native guarantee.

**Sui difference from Aptos:** the wallet must be a *shared* object (not owned by
one address) so the N owners can all act on it. This changes consensus path
(shared objects use full consensus) and the code structure vs Aptos's resource.

---

## 7. NEAR port (Rust / near-sdk → WASM)

**Model.** A contract deployed to its own NEAR account, holding owners,
threshold, security params, and a proposal map in contract state. NEAR tokens held
by the contract account; NEP-141 tokens via cross-contract calls.

**Guarantee mapping:**
- G1/G3: owners in contract state; LF never added. The contract's *full-access
  key* is the backdoor risk (see below) — it must not be held by Liquid Flow.
- G2: `approve` records distinct `predecessor_account_id`s; `execute` checks quorum.
- G4: sweep transfers full balance to an allowlisted account.
- G5/G6: allowlist map with `active_at` (block timestamp); guardian cancel while pending.
- G7: proposal `ready_at`; checked against `env::block_timestamp()`.
- G8: rolling-window fields; checked on execute.
- G9: `paused`; pause by owner/guardian; unpause quorum-gated.
- G10: guardian account id; pause/cancel only.
- G11: NEAR cross-contract calls are async (promises) — token transfers need
  callback handling to confirm success and avoid state desync; `executed` set only
  after confirmation. No synchronous reentrancy, but promise-callback ordering
  must follow checks-effects-interactions carefully.

**NEAR-specific risks:** the contract account's **full-access keys** can redeploy
or delete the contract. They must be removed (contract becomes "locked") or held
by a builder/guardian multisig. NEAR's async token model also means refund/failure
paths need explicit callbacks — more care than EVM's synchronous reverts.

---

## 8. Cross-cutting risks (all non-EVM)

1. **Upgrade/redeploy authority is the universal backdoor.** Solana upgrade
   authority, NEAR full-access keys, and Move package upgrade policy each let the
   holder replace logic. For genuine non-custody, these must be burned or held by a
   builder/guardian multisig — NEVER by Liquid Flow. This is as important as the
   instruction-level logic.
2. **Token standards differ** (SPL, Aptos `Coin`/fungible-asset, Sui `Coin`,
   NEP-141) — each needs its own transfer + balance code.
3. **Time sources differ** (Solana `Clock`, Aptos/Sui timestamp, NEAR
   `block_timestamp`) — time-lock/velocity use each chain's native clock.
4. **Async vs sync** — NEAR (and some flows elsewhere) are async; success must be
   confirmed in callbacks before marking a proposal executed.
5. **Testing parity** — each port needs its own test suite asserting G1–G11 on
   that chain's local validator/simulator before it's considered done.

---

## 9. Build order (proposed)

1. **Solana** — largest non-EVM user base; Anchor is well-trodden.
2. **Aptos** — Move resource model; strong native fund-safety.
3. **Sui** — reuses Move knowledge from Aptos (different model, same language).
4. **NEAR** — async model needs the most careful callback handling; do last.

Each delivered with: contract source, a test suite asserting G1–G11, and local
build/test instructions. Verification runs on a machine with that chain's
toolchain (the sandbox here blocks Solana/NEAR/Move compiler downloads).

---

## 10. Honest verification note

EVM contracts were compiled (solc) and executed against a real EVM in-sandbox.
The four non-EVM toolchains (Anchor, Move CLIs, near-sdk) are network-restricted
here, so their code will be review-grade with local verification instructions,
not sandbox-compiled. Nothing will be claimed "verified" that wasn't actually run.
Independent audit + formal verification remain required before mainnet on every
chain.

---

## 11. Change log

- **v0.2** — Built all four non-EVM platform-wallet contracts (review-grade):
  Solana (`contracts/solana`, Anchor/Rust), Aptos (`contracts/aptos`, Move
  resource model), Sui (`contracts/sui`, Move shared-object model), NEAR
  (`contracts/near`, near-sdk/Rust async). Each enforces G1–G11 with build
  manifests and a per-chain README (`contracts/NONEVM_README.md`) including local
  build/test commands and the critical post-deploy upgrade-authority step. Two
  review flags annotated inline (Solana PDA lamport borrow; Aptos borrow ordering)
  for first-compile verification. Not sandbox-compiled (toolchains network-blocked).
- **v0.1** — initial multi-chain design: shared G1–G11 guarantee model; per-chain
  mapping for Solana (Anchor), Aptos (Move), Sui (Move/objects), NEAR (near-sdk);
  cross-cutting risks (upgrade authority as the universal backdoor); build order.
