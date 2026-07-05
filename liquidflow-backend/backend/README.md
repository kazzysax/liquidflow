# LiquidFlow Backend — Foundation

Non-custodial gated-payment infrastructure. This is the **foundation layer**:
database schema, wallet-based auth, the money primitive, and the API skeleton.

## Stack (strongest-for-the-job)

| Layer | Choice | Why |
|---|---|---|
| On-chain logic | **Solidity** (Foundry) | The gate must be enforced trustlessly on-chain, not just claimed off-chain. |
| Off-chain service | **Rust** (Axum) | Memory-safe, no nulls/data races, errors-as-values. `unsafe` is `forbid`-en crate-wide. |
| Database | **PostgreSQL** | Append-only ledger, integer money, serializable isolation on the money path. |

## The one inviolable rule

**The backend never holds private keys and never moves user funds.** It builds
unsigned transactions, records state derived from on-chain truth, and serves
data. Custody and fund movement happen only via the user's own wallet signing,
and via on-chain contracts. The schema has nowhere to store a key by design.

## What's in this foundation

```
backend/
  migrations/
    0001_init.sql              # schema: users, auth, sessions, locks, fundraisers, ledger
    0001_invariants_test.sql   # proves append-only + money-safety guarantees
  src/
    money.rs                   # integer base-unit Amount; checked arithmetic; no floats
    auth.rs                    # SIWE challenges, signature verify, hashed sessions
    api.rs                     # Axum routes: /health, /auth/challenge, /auth/verify
    lib.rs / main.rs           # wiring + server entrypoint
  verify.sh                    # compile + test + DB-invariant verification
```

## Security properties enforced (and tested)

These are verified by `0001_invariants_test.sql` against a real Postgres, and by
the Rust unit/property tests:

1. **Append-only ledger** — `UPDATE` and `DELETE` on `ledger_entries` are blocked
   by triggers. Corrections are reversing inserts, never edits.
2. **Idempotency** — every ledger event carries a unique `idempotency_key`; the
   same money event cannot be written twice (defeats double-spend on retry/replay).
3. **Integer money only** — amounts are 256-bit integers in base units, stored as
   digit-strings with a `CHECK` constraint. No floating point anywhere. The Rust
   `Amount` type rejects signs, decimals, and whitespace, and uses checked
   add/sub (overflow/underflow are errors, never silent wraps).
4. **Non-custodial auth** — sign-in is by wallet signature over a single-use,
   time-limited nonce. No passwords, no keys stored. Session tokens are 256-bit
   random values stored only as SHA-256 hashes, so a DB leak yields no usable tokens.

## How to verify (on a machine with Rust + Docker)

```bash
cd backend
chmod +x verify.sh
./verify.sh
```

Expected: formatting, clippy (warnings denied), release build, all unit/property
tests, and the SQL invariant tests all pass; script exits 0.

### Run just the DB invariant proof (Docker only)

```bash
docker run -d --name lfpg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16
docker exec -i lfpg psql -U postgres -c "CREATE DATABASE liquidflow;"
docker exec -i lfpg psql -U postgres -d liquidflow < migrations/0001_init.sql
docker exec -i lfpg psql -U postgres -d liquidflow < migrations/0001_invariants_test.sql
# look for: PASS lines + "ALL INVARIANT TESTS PASSED"
```

## Known item to confirm on first compile

`src/auth.rs::verify_signature` uses alloy's signature-recovery API. The exact
type path / method name varies across alloy versions; the inline NOTE marks it.
The *logic* (recover signer from the signed message, compare to the claimed
address) is correct regardless. Confirm against your pinned `alloy` version with
`cargo build`.

## What this foundation deliberately does NOT do yet

- Persist challenges/sessions/locks (handlers note where the `sqlx` INSERTs go).
- Chain watching / transaction building (the chain-interaction layer).
- The Solidity contracts (Wise Unlock vault, etc.).
- Per-system business logic beyond the schema.

These build on top of this foundation next.

## Verification status (honest)

- **Schema + invariants:** executed against real PostgreSQL 16 — **passing**.
- **Rust modules:** written to compile under the pinned crates, with unit +
  property tests included, but **not compiled in the authoring sandbox** (the
  Rust toolchain download was network-restricted there). Run `verify.sh` locally
  to confirm. Nothing is claimed as "verified" that wasn't actually run.
