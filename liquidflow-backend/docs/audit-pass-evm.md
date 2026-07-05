# Liquid Flow — Static-Analysis-Style Audit Pass (EVM contracts)

Method: a manual pass emulating what Slither / Mythril / Aderyn check — the SWC
registry vulnerability classes — read against the actual current source of
`PlatformWallet`, `SecurePlatformWallet`, `PaymentGate`, `PayrollScheduler`.

Severity scale: **High** (funds at risk) · **Medium** (can break a guarantee in
some conditions) · **Low** (hardening / best-practice) · **Info** (note).

**This is not a substitute for a professional audit.** It reflects what an
experienced reader + the common automated tools would surface. Unknown-unknowns
are exactly what a paid audit firm is for.

---

## Summary table

| # | Finding | Contract | Severity | Status |
|---|---|---|---|---|
| F1 | Token velocity not enforced on-chain | SecurePlatformWallet | Medium | Documented limitation |
| F2 | Sweep can be blocked by velocity cap | SecurePlatformWallet | Low | By design; note for ops |
| F3 | `pay()` forwards to merchant via low-level call | PaymentGate | Low | Acceptable (CEI + nonReentrant) |
| F4 | No deadline sanity-check on `expiry` / `releaseTime` | PaymentGate, Payroll | Low | Off-chain responsibility |
| F5 | Timestamp dependence (block.timestamp) | Secure, Gate, Payroll | Low | Acceptable for these windows |
| F6 | Owner set is immutable (no add/remove) | Platform, Secure | Info | Deliberate v0 scope |
| F7 | `settleToken` trusts operator to name the token | PaymentGate | Low | Cannot misroute (only → merchant) |
| F8 | Unbounded owner loop on construction | all | Info | Bounded by MAX_OWNERS in practice |

No **High** findings. Reentrancy, access control, and "operator can't move funds"
all hold (confirmed by the attack suites: 21 attacks + 5 regression, 0 vulns).

---

## Detailed findings

### F1 — Token velocity is not enforced on-chain (Medium) — FIXED (logic), token-path test pending
`_checkVelocity` only ran for native withdrawals. **Fix applied:** added per-token
rolling 24h caps (`tokenDailyLimit` / `tokenWindowStart` / `tokenSpentInWindow`),
enforced in both token branches of `execute`, plus `setTokenLimitTighten` (any
single owner may add or lower a token cap — tightening is always safe; raising or
clearing is disallowed in v0). Compiles clean; native suites still pass (no
regression).
**IMPORTANT honesty note:** the *token* execution paths (this fix, the original
`WithdrawToken`/`SweepToken`, and PaymentGate `settleToken`) could NOT be executed
in the authoring sandbox — the `@ethereumjs/vm` harness used here cannot perform
internal contract-to-contract `.call`s to an ERC-20 (a minimal 8-line reproduction
confirmed this is a VM-harness limitation, not a contract bug). Consequence: **all
passing EVM tests to date exercised native coin only; the ERC-20 paths are
unverified in this environment.** They must be tested with a real toolchain
(Foundry/Hardhat, forking mainnet with real token contracts) in VS Code. This is
the single most important verification gap to close for token support.

### F2 — A pending sweep can be blocked by the velocity cap (Low)
`SweepNative` runs `_checkVelocity(entireBalance)`; if the balance exceeds
`dailyLimit`, the sweep reverts. That's *intended* (a drain-sized move shouldn't
slip through), but operationally a legitimate full sweep may need the limit
raised first (itself a quorum action) or a carve-out.
**Recommendation:** document the operational runbook; optionally exempt sweeps
that go to an allowlisted *owner-controlled* address from the cap.

### F3 — `pay()` forwards via low-level call to merchant (Low)
`pay()` does `merchant.call{value:…}`. If `merchant` is a contract that reverts on
receive, the payment reverts (payer protected, no funds stuck). Reentrancy is
covered by `nonReentrant` + state set before the call (CEI). No issue; noted
because scanners flag low-level calls by default.

### F4 — No sanity bounds on `expiry` / `releaseTime` (Low)
`openPayment` accepts any `expiry` (incl. past → immediately unusable, or far
future). `schedule` accepts any `releaseTime`. Not a fund risk (a past expiry just
makes `pay` revert; a far-future release just sits), but a fat-fingered value
could confuse ops.
**Recommendation:** validate ranges off-chain in the API; optionally
`require(expiry > block.timestamp)` in `openPayment` for clearer failure.

### F5 — Timestamp dependence (Low)
Time-locks, expiry, and velocity windows use `block.timestamp`. Miners/proposers
can nudge it by a few seconds. For 24h windows and hour-scale delays this is
immaterial (the manipulable drift is tiny relative to the windows). Acceptable.

### F6 — Owner set immutable in v0 (Info)
`PlatformWallet` / `SecurePlatformWallet` have no add/remove-owner. Deliberate to
minimize the audited surface. **Consequence:** a lost owner key can't be rotated
without redeploying + migrating funds. Plan governed owner-management (behind the
same quorum) for v0.2, as already noted in the multichain doc.

### F7 — `settleToken` trusts the operator to pass the right token (Low)
The operator names which `token` to settle. Worst case they name the wrong token —
but `_sendToken` always sends to `merchant`, so they still cannot misroute funds
to themselves. Cosmetic/accounting risk only.
**Recommendation:** record the expected token in the Payment at openPayment time
and check it here, so settlement can't be triggered for an unexpected asset.

### F8 — Unbounded loop over owners at construction (Info)
Constructors loop over `initialOwners`. Gas-bounded by caller; `MAX_OWNERS` is
enforced on the Solana port but the EVM constructors don't hard-cap N.
**Recommendation:** add `require(initialOwners.length <= 20)` for symmetry and to
prevent an accidental huge-array deploy.

---

## What was checked and found clean

- **Reentrancy (SWC-107):** `nonReentrant` on all fund-moving fns; CEI ordering
  (state set before external calls). Reentrancy attacker contract tested — held.
- **Access control (SWC-105/115):** every privileged fn gated by `onlyOwner` /
  `onlyOperator` / `onlyCompany`; no `tx.origin`; no missing modifiers found.
- **Unchecked call return (SWC-104):** all low-level calls check the bool and
  revert on failure; token calls also decode the optional bool.
- **Integer over/underflow (SWC-101):** Solidity 0.8 checked math throughout; no
  `unchecked` blocks.
- **Replay / double-spend:** `executed` / `settled` / `released` flags block
  re-execution; tested.
- **Default visibility (SWC-100):** all functions have explicit visibility.
- **Uninitialized storage (SWC-109):** no dangling storage pointers.
- **Delegatecall / selfdestruct (SWC-106/112):** none used.
- **Stale unpause votes:** FOUND in self-audit, FIXED (epoch-scoped), regression-
  tested.

---

## Priority before mainnet

1. **F1 (Medium):** add per-token velocity limits if tokens are a primary asset.
2. **F7 / F4 (Low):** bind expected token + bound expiry for cleaner failure modes.
3. **F8 (Info):** cap owner-array length on EVM constructors.
4. Then: **independent professional audit + formal verification + bug bounty** —
   none of the above replaces that.
