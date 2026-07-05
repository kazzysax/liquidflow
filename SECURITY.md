# Liquid Flow — Security & Audit Status

> **This documents internal reviews, not a professional audit.** Tested ≠ audited.
> Liquid Flow is **testnet-only** until the GO-LIVE Phase 5 gate is cleared:
> an independent smart-contract audit, a dedicated cryptographic audit of the
> stealth scheme, formal verification of the "no unauthorized fund movement"
> invariant, a testnet bug bounty, and legal/regulatory sign-off. Do not point
> this at real funds before then.

## Non-custodial invariant (what every review checks)

Liquid Flow's keys can **time and authorize** actions but can **never move funds**.
If LF's servers were fully compromised, an attacker still could not move user money.
Every finding below is judged against that invariant first.

---

## Review passes completed

### 1. EVM contract static-analysis pass
Manual pass emulating Slither / Mythril / Aderyn (SWC registry classes) against
`PlatformWallet`, `SecurePlatformWallet`, `PaymentGate`, `PayrollScheduler`.
8 findings, **no High**, reentrancy / access-control / "operator can't move funds"
all hold. → [`liquidflow-backend/docs/audit-pass-evm.md`](liquidflow-backend/docs/audit-pass-evm.md)

### 2. Adversarial + regression suites
91 checks green, 0 vulnerabilities: 51 functional + 28 adversarial (attack suites) +
12 crypto-proof. → [`liquidflow-backend/docs/checkup-report.md`](liquidflow-backend/docs/checkup-report.md)

### 3. Security-hardening review — payments, API & mainnet readiness (2026-07)
Full read of the live Vercel API (`api/`), the stealth crypto libs, and all contracts,
against known real-world breach classes. **17 issues found and fixed.** A plain-English
walkthrough of each (what it was, how it could be exploited, the fix) accompanies this
review. Summary below.

---

## Findings from the 2026-07 hardening review (all fixed)

### Confirmation integrity — "marked paid without paying"
| Sev | Issue | Location | Fix |
|-----|-------|----------|-----|
| Critical | Zero/negative amount confirmed instantly (`bal >= 0` always true) | `api/payments`, `api/fundraisers` | Strict positive-integer base-unit validator |
| Critical | Instant mode confirmed against the merchant's reused wallet balance, not the payment | `api/_lib/chain.js` | Baseline captured at creation; confirm only on a rise of ≥ amount; fail-closed |
| Critical | "Confirmations" were cosmetic — confirmed at chain tip, reversible by reorg | `api/_lib/chain.js` | Read balance at reorg-safe depth (24/30 blocks; Solana `finalized`) |
| Medium | Same payment could be confirmed twice (poll vs. cron race) | `api/_lib/confirm.js` | Re-read + claim before announcing |

### Access & authentication — "unlocked doors"
| Sev | Issue | Location | Fix |
|-----|-------|----------|-----|
| High | Payroll registry unauthenticated + overwritable (keeper griefing) | `api/payroll` | On-chain verify contract names our keeper; first-writer-wins |
| High | Keeper key could be aimed at any contract via the URL | `api/payroll/[contract].js` | Auto-release only for registered, verified payrolls |
| High | Cron auth failed open (`Bearer undefined` accepted if secret unset) | `api/cron/watch.js` | Fail closed when no secret configured |
| High | Webhook SSRF — server fetched merchant-supplied internal URLs | `api/_lib/webhook.js` | Block localhost / private / link-local / metadata (169.254.169.254) |

### Contracts & funds — "money that could freeze or slip away"
| Sev | Issue | Location | Fix |
|-----|-------|----------|-----|
| High | Full "sweep" bypassed the large-withdrawal timelock | `SecurePlatformWallet.sol` | Sweeps always timelocked; added immediate destination revoke |
| Medium | One frozen recipient reverted the whole ERC-20 payroll batch | `PayrollSchedulerERC20`, `payroll.js` | Fall back to per-payout release on batch revert |
| Medium | `openPayment(amount=0)` = open-ended gate could scoop other tokens | `PaymentGate.sol` | Reject zero amount at open |
| Low | Curve points not validated (invalid-curve class) | `api/_lib/crypto.js` | On-curve validation before use |

### Mainnet readiness & stealth
| Sev | Issue | Location | Fix |
|-----|-------|----------|-----|
| Critical | ed25519 stealth keys unspendable in standard Solana/Sui wallets (fund loss) | `api/_lib/stealth_ed25519.js` | Hard-disabled behind `ENABLE_ED25519_STEALTH`; program-based replacement drafted ([`STEALTH_GATE.md`](liquidflow-backend/contracts/STEALTH_GATE.md)) |
| Critical | Merchants never received `R`, so even sound EVM stealth deposits were unwithdrawable | `api/payments/recover.js`, `tools/` | Merchant-auth recovery endpoint + offline sweep tool (keys never server-side) |
| High | Mainnet chains fell back to shared public RPCs | `api/_lib/chain.js` | Explicit RPC env required for `eip155:1` / `eip155:8453` |
| Medium | Silent in-memory store in production (per-instance, ephemeral) | `api/_lib/store.js` | Hard-fail in production without the shared store |
| Low | Fundraiser goal not validated | `api/fundraisers` | Must be a positive number |

---

## Still open / intentionally gated

- **Solana & Sui private (stealth) payments** stay disabled until the program-based
  `stealth_gate` deposit model is built, compiled, and audited. The drafted Solana
  program is review-grade and **not yet compiled or audited**.
- **Instant-mode residual:** two *simultaneous, identical* invoices to the same payout
  address can still both confirm off one payment. Full cure = route instant mode through
  `PaymentGate.sol`.
- **Everything above is self-review.** The Phase 5 external audits remain the real gate
  before mainnet.

## Reporting a vulnerability

Found something? Email the maintainer (see repo owner) with steps to reproduce. Please
do not open a public issue for anything that could put funds at risk.
