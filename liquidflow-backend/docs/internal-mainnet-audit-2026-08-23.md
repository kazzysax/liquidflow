# LiquidFlow Internal Mainnet Audit — 2026-08-23

## Status

**NOT CLEARED FOR MAINNET FUNDS.** This is an internal engineering review, not an
independent audit certificate. The internal critical accounting defects identified in
this review are now remediated, but mainnet activation remains blocked by an external
cryptography/smart-contract assessment and the operational items below.

Scope reviewed: EVM stealth derivation and recovery, merchant creation, ERC-20 payment
confirmation, Circle CCTP V2 transaction planning/relay, PaymentGate token settlement,
Redis state transitions, webhooks, and offline settlement tooling.

## Resolved findings

### LF-A01 — Merchant could not recover stealth deposits (Critical)

Merchant signup returned `k_spend` but not `k_view`, while the offline sweep tool needs
both. New stealth merchants now receive both keys, and authenticated recovery returns
the read-only view key for pre-existing merchants. LiquidFlow still never stores or
returns the spend key.

### LF-A02 — Offline sweep supported native coin only (High)

VERSE, fxVERSE and USDC deposits are ERC-20 balances. Recovery exports now include the
server-derived canonical token contract, and the offline sweep tool transfers ERC-20s,
estimates required native gas, and refuses recovery files whose token contract differs
from the hardcoded chain allowlist.

### LF-A03 — Secret scalars were not range validated (Medium)

Production stealth functions now require exact 32-byte hexadecimal secrets inside the
secp256k1 scalar range. Payment contexts are bounded to 1–256 UTF-8 characters and
malformed curve points are rejected.

### LF-A04 — Confirmation transition was non-atomic (High)

Two Vercel instances could both observe an awaiting payment and send duplicate
confirmation webhooks. A Redis `NX` lock now permits one state-transition owner. A
short TTL permits recovery if an instance terminates before completing the transition.

### LF-A05 — Solidity tests contradicted security controls (Low)

The sweep test skipped the mandatory timelock and another test expected zero-value
payment gates even though the contract rejects them. Tests now assert the intended
fail-closed behavior. Current result: 14/14 Foundry tests pass.

## Accounting remediations and remaining mainnet blockers

### LF-A06 — Transfer-event accounting and payer attribution (Critical, resolved)

Payments are anchored to the chain head at creation. The watcher now queries canonical
token `Transfer` logs at the configured confirmation depth, deduplicates transaction/log
identifiers, records senders and hashes, and classifies exact, partial, excess, expired,
and multiple-sender deposits. Multiple senders fail closed into manual review.

### LF-A07 — PaymentGate pooled ERC-20 settlement (Critical, resolved by disablement)

`PaymentGate.settleToken` is hard-disabled and tested to revert, including for the
operator. Core ERC-20 checkout continues through unique merchant-controlled deposit
addresses. A future contract token path requires invoice-isolated `transferFrom`
accounting and a separate audit before it can be enabled.

### LF-A08 — Refund classification and authorization (Critical, partially resolved)

The watcher records `awaiting_topup`, `refund_pending`, and `manual_review`, locks the
refund destination to the sole confirmed Transfer sender, and queues only the proper
excess or expired partial amount. Refund execution remains merchant-authorized and is
not silently signed by the server. The signed execution and `refunded`/`refund_failed`
receipt workflow remains an operational mainnet blocker.

### LF-A09 — Gas-station funding is not implemented (High)

ERC-20 deposit addresses require native gas before sweep/refund: ETH on Ethereum, POL
on Polygon, and ETH on Base. The offline tool now reports the deficit, but no capped,
just-in-time gas sponsor exists. Never pre-fund unused addresses. Fund only a confirmed
canonical deposit after estimating its exact settlement/refund transaction.

### LF-A10 — Automatic merchant settlement is not implemented (High)

CCTP quote, attestation, and relay primitives exist, but there is no audited state
machine connecting a confirmed payment to merchant-selected settlement, retries,
receipt state, or failure recovery. CCTP relay must remain opt-in and gas-capped.

### LF-A11 — VERSE DEX route is not implemented (High)

No approved router allowlist, minimum-output calculation, slippage ceiling, deadline,
or liquidity/oracle protection exists. Do not advertise automatic VERSE conversion
until an official route is pinned and adversarially tested.

### LF-A12 — Webhook DNS rebinding remains possible (Medium)

Literal private addresses and obvious internal hostnames are blocked, but hostname
validation does not resolve and pin public IPs at delivery time. Production webhook
delivery needs DNS resolution checks, redirect prohibition, and a pinned connection or
an outbound delivery service with SSRF controls.

### LF-A13 — External audit and small-value mainnet rehearsal required (Critical gate)

Internal tests cannot certify custom stealth cryptography or contracts. Before real
funds: obtain an independent review, verify deployed bytecode/contracts through
multiple RPCs, run small-value VERSE/USDC payments on all five asset/network routes,
exercise recovery, and document emergency procedures.

## Evidence

- Node security/engine tests: **17 passed, 0 failed**.
- Foundry contract tests: **10 passed, 0 failed**.
- Production dependency audit (`--omit=dev`, high threshold): **0 vulnerabilities**.
- Canonical asset allowlist covered by tests: VERSE/Ethereum, fxVERSE/Polygon,
  USDC/Ethereum, USDC/Polygon, USDC/Base.
- CCTP domain allowlist covered by tests: Ethereum `0`, Base `6`, Polygon `7`.

Passing tests demonstrate the assertions tested; they do not override the open design
findings above.
