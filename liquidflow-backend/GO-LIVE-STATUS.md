# Liquid Flow — Testnet Readiness & Go-Live Status

Honest assessment of what exists, what's needed to test on testnet, and the
direct answer to "are we set to go live?"

---

## Direct answer: are we set to go live on MAINNET?

**No — not yet, and going live now would risk user funds.** This is a strong,
well-tested *foundation*, not a finished product. The gaps below are not opinions;
they are the standard, non-negotiable steps every serious crypto-payments project
completes before touching real money. Be proud of where this is — and don't skip
the runway.

**Are we set to test on TESTNET?** Partially. The EVM contracts can go to testnet
now. The rest (non-EVM, backend services, the privacy/stealth flows end-to-end)
needs the build + verify steps below first.

---

## What you HAVE (and how solid each piece is)

### Frontend — payer / platform / payee surfaces
| File | Audience | State |
|---|---|---|
| index.html / liquidflow-landing.html | public | done, polished |
| gateway.html | builder | done (2 systems: Integrate Payment, Potlock) |
| potlock-create.html | builder | done |
| potlock-fundraiser.html | public | done |
| potlock-private.html | public/payer | done (progression curve, private donate) |
| receipt-verify.html | payee/support staff | done, real Ed25519 verification in-browser |

These are **UI demos** — visually complete and on-brand, with some real crypto
(receipt verification). They are NOT yet wired to a live backend or real wallets.

### Contracts — EVM (the strongest part)
| Contract | Tests | State |
|---|---|---|
| PlatformWallet.sol | 12/12 | compiled + EVM-verified |
| SecurePlatformWallet.sol | 15/15 | compiled + EVM-verified, +per-token velocity |
| PaymentGate.sol | 11/11 | compiled + EVM-verified |
| PayrollScheduler.sol | 15/15 | compiled + EVM-verified |
| attack suites + regression | 21 + 5 | 0 vulnerabilities; 1 real bug found & fixed |

**Caveat that matters:** all passing tests exercised NATIVE coin. The ERC-20 token
paths could not run in the dev sandbox and are UNVERIFIED — top priority on testnet.

### Contracts — non-EVM (Solana / Aptos / Sui / NEAR)
Review-grade, written with build manifests + a README. **Never compiled or tested**
(toolchains weren't available in the dev sandbox). Two earlier review flags fixed.

### Privacy / crypto cores (proven in isolation)
| Module | Tests | State |
|---|---|---|
| receipts/demo (anti-forgery) | 6/6 | runnable, real Ed25519 |
| potlock/stealth_demo | 6/6 | runnable, real secp256k1 |
| potlock/attack_stealth | 7/7 secure | adversarial |
| payments/stealth_payment_demo | 7/7 | private deposit addresses |
| payments/unlink_demo | 6/6 | payer↔merchant unlinking |

These prove the MATH. They are not yet wired into contracts or services.

### Backend (Rust) + DB
Schema + append-only ledger invariants verified against real Postgres. Rust
modules (money, auth, api, receipts) WRITTEN but NOT compiled (toolchain blocked).

### Docs
Full living spec (v0.7), multichain design, payment-problem-solvers, potlock
privacy design, audit pass, checkup report.

---

## What is NOT built yet (the missing runtime)

These are the pieces that turn "proven components" into "a running tool":

1. **Deposit-watcher / chain-interaction service** — watches chains, counts
   confirmations, matches deposits to paymentId, recognizes stealth payments via
   the view key, fires webhooks. **Nothing works end-to-end without this.** It is
   the single biggest missing piece.
2. **Merchant API + webhooks** — create-payment, status, the private R delivery
   channel, config endpoints.
3. **Wiring**: frontend → backend → contracts. Right now they're separate.
4. **DEX-aggregator integration** (you asked) — the unify-liquidity swap path
   (1inch / 0x / Jupiter). Designed in the spec, NOT implemented.
5. **Onboarding wizard** that captures chain choice, settlement currency, DEX
   provider, unify on/off, plans, payout wallet, webhook — as a real form that
   produces an API key. Currently described, not built.
6. **View-key scanner** for totals (Potlock + private payments).
7. **Non-EVM contract compilation + tests** (your VS Code track).

---

## DEX provider & "all necessary selections" — status

You asked about DEX provider and other selections. Current state: these are
**specified in the design** (builder picks chains, settlement currency, DEX
aggregator, unify on/off, the two plans, payout wallet, webhook) but the
**onboarding wizard UI and the swap integration are not built**. So the selections
exist on paper, not yet as a working configurable flow. This is a real build item,
not done.

---

## Path to testnet (do these in order)

**Phase 1 — EVM contracts to testnet (ready now)**
1. In VS Code with Foundry/Hardhat: import the 4 contracts.
2. Write/port the token-path tests against real ERC-20s (close the #1 gap).
3. Deploy to a testnet (Base Sepolia / Sepolia). Exercise pay → settle → events.

**Phase 2 — non-EVM contracts (your VS Code track)**
4. Install Solana/Aptos/Sui/NEAR toolchains; compile + test each; port the parity
   suite (G1–G11) + the attack suites.

**Phase 3 — backend services**
5. Compile the Rust backend (resolve the alloy/sqlx notes); stand up Postgres.
6. Build the deposit-watcher + merchant API + webhook delivery.
7. Wire the stealth view-key scanner.

**Phase 4 — integration**
8. Build the onboarding wizard + DEX-aggregator swap path.
9. Wire frontend → API → contracts. Test the full payer→confirm→webhook loop on
   testnet, both public-gate and private-stealth modes.

**Phase 5 — pre-mainnet gate (non-negotiable)**
10. Independent professional smart-contract audit (every contract, every chain).
11. Dedicated CRYPTOGRAPHIC audit of the stealth scheme (highest-risk component).
12. Formal verification of the core "no unauthorized fund movement" invariant.
13. Testnet bug-bounty period.
14. Legal/regulatory review: money-transmission, AML/KYC, travel-rule, and the
    privacy posture specifically (counsel must sign off before mainnet).

---

## Bottom line

You have a genuinely strong, security-conscious foundation: 4 EVM contracts that
survived adversarial testing (and revealed one real bug, now fixed), proven privacy
crypto, an honest threat model, and complete design docs. That is real, fundable
work.

It is **not go-live ready**. The runtime (watcher, API, wiring), the non-EVM
verification, the DEX/onboarding build, and — above all — independent audit +
counsel review stand between here and mainnet. Testnet (EVM first) is the right
next move, and most of Phase 1 can start today.
