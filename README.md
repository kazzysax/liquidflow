# Liquid Flow

Non-custodial multi-chain crypto payment platform. Two systems: **Integrate
Payment** (a gateway other platforms embed) and **Potlock** (private fundraising
with stealth addresses).

> **Testnet only.** Not mainnet-ready — real funds wait on the Phase 5 gate
> (see [SECURITY.md](SECURITY.md) and GO-LIVE.md). The code is security-hardened
> and configured to mainnet standards, but external audits + legal sign-off come first.

## Non-custodial principle

Liquid Flow's keys can time and authorize actions but can **never move funds**. If
LF's servers were fully compromised, an attacker still could not move user money.
Every build step must preserve this.

## Repository layout

| Path | What |
|------|------|
| `api/` | **Live serverless API (Vercel).** Payments, merchants, fundraisers, payroll, the deposit-watcher cron, the stealth recovery endpoint, and Arc cross-chain swaps (CCTP). |
| `api/swap/` | **Cross-chain USDC via Circle CCTP** — move USDC in/out of Arc. `POST /api/swap/quote` (returns the approve+burn txs to sign — non-custodial), `GET /api/swap/status` (attestation), `POST /api/swap/relay-mint` (optional LF-relayed mint). |
| `api/_lib/` | Core libs: chain reads + confirmation, stealth crypto, KV store, webhooks, payroll keeper. |
| `tools/` | Operator/merchant tooling — e.g. the offline EVM stealth **sweep tool** (keys never leave the merchant's machine). |
| `*.html` | Frontend (landing, gateway, onboarding wizard, potlock, receipt verify). |
| `liquidflow-backend/contracts/` | EVM contracts (Solidity, tested) + non-EVM programs (Solana/Sui/Aptos/NEAR, review-grade). |
| `liquidflow-backend/payments/` `potlock/` `receipts/` | Proven privacy-crypto demos. |
| `liquidflow-backend/backend/` | Rust backend reference (compile locally). |
| `liquidflow-backend/docs/` | Design specs, EVM audit pass, checkup report. |

## Configuration

Copy `.env.example` and fill in the values (real secrets are git-ignored):

- `UPSTASH_REDIS_REST_URL` / `_TOKEN` — the shared store. **Required in production**
  (the app refuses to run on ephemeral in-memory storage there).
- RPC endpoints — testnets have public fallbacks; **mainnet chains
  (`eip155:1`, `eip155:8453`) require an explicit RPC** (no public fallback for real money).
- `CRON_SECRET` — protects the deposit-watcher cron in production (fails closed if unset).
- `LF_OPERATOR_KEY` / `LF_OPERATOR_ADDRESS` — payroll keeper (timing key only).
- `ENABLE_ED25519_STEALTH` — **leave off.** Solana/Sui stealth is gated pending audit
  (see [STEALTH_GATE.md](liquidflow-backend/contracts/STEALTH_GATE.md)).

## Run the proofs (Node + browser, no toolchains)

- Open the `*.html` files in a browser (start with `index.html`).
- `node liquidflow-backend/potlock/stealth_demo.js` and the other demos in
  `payments/`, `potlock/`, `receipts/`, `api/`.
- EVM contract tests: `cd liquidflow-backend/contracts`, install the deps in
  `VSCODE-TASKS.md`, then `node test/<name>.test.js`.

## Security

See **[SECURITY.md](SECURITY.md)** for the full audit/review status: the EVM
static-analysis pass, the 91-check attack/regression suite, and the 2026-07
security-hardening review (17 findings, all fixed) — plus what's still gated.

## Going live

Start with **GO-LIVE.md** (master instructions), then
`liquidflow-backend/VSCODE-TASKS.md` (phase-by-phase) and
`liquidflow-backend/GO-LIVE-STATUS.md` (honest status).
