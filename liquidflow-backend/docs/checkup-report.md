# Liquid Flow — Routine Checkup Report

Full-project verification run. Honest status of what is tested, what is
review-grade, and what remains.

## Test suites — all passing

### EVM contracts (compiled + executed against a real EVM)
| Suite | Result |
|---|---|
| PlatformWallet | 12 passed, 0 failed |
| SecurePlatformWallet | 15 passed, 0 failed |
| PaymentGate | 11 passed, 0 failed |
| PayrollScheduler | 15 passed, 0 failed |
| attack_SecurePlatformWallet | 8 secure, 0 vulns |
| attack_deep (gate/payroll/wallet) | 13 secure, 0 vulns |
| regression_unpause (stale-vote fix) | 5 passed, 0 failed |

### Potlock stealth crypto (real secp256k1)
| Suite | Result |
|---|---|
| stealth_demo (correctness) | 6 passed, 0 failed |
| attack_stealth (adversarial) | 7 secure, 0 vulns |

### Receipts
| Suite | Result |
|---|---|
| receipt_demo (anti-forgery, Ed25519) | 6 passed, 0 failed |

**Totals: 51 functional + 28 adversarial + 12 crypto-proof checks = 91 green, 0 red.**

## Compilation
All four EVM contracts compile clean (solc 0.8.28): PlatformWallet 4393 B,
SecurePlatformWallet 7846 B, PaymentGate 3060 B, PayrollScheduler 3691 B.

## Frontend integrity
6 pages (gateway, landing, potlock-create, potlock-fundraiser, potlock-private,
receipt-verify) + index.html. All internal links resolve. Wise Unlock fully
removed (pages + gateway bar + routes), no dead links.

## Findings from this checkup (honest)

1. **Stealth attack 6 — backend dedupe requirement.** A reused ephemeral `R` maps
   to the same stealth address. The math is safe, but the **backend MUST dedupe
   credits by transaction hash, not address**, or a replayed announcement could
   double-count the public total. Not yet enforced (backend not built).
2. **Stealth attack 7 — input validation requirement.** Degenerate/identity
   ephemeral keys must be rejected at the input layer (defense-in-depth). Not yet
   enforced (backend not built).
3. **index.html links** (pre-existing) resolved by creating the homepage file.

## What remains NOT verified / NOT built (carried forward honestly)

- **EVM ERC-20 token paths** — could not be executed in this sandbox's JS-EVM
  (internal token `.call` unsupported here). All passing EVM tests exercised
  NATIVE coin only. Token paths must be tested with Foundry/Hardhat forking
  mainnet. **Highest-priority verification gap.**
- **Non-EVM contracts (Solana/Aptos/Sui/NEAR)** — review-grade, never compiled
  (toolchains blocked here). To verify in VS Code.
- **Potlock contracts** (campaign vault, view-key scanner, per-chain stealth
  derivation for the 4 ed25519 chains) — NOT built. Only the design + crypto proof
  exist. The non-EVM stealth derivation is the highest-risk crypto in the project
  and needs dedicated cryptographic audit.
- **Deposit-watcher, merchant API** — NOT built.
- **No professional audit / formal verification / bug bounty** on anything yet.

## Bottom line
Everything that exists and can be tested here is green, including adversarial
testing of both the EVM contracts and the stealth crypto. The verification GAPS
are about scope not yet built or not runnable in this sandbox — not about known
failures. None of it is audit-complete; that remains the gate before real funds.
