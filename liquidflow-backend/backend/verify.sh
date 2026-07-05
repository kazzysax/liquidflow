#!/usr/bin/env bash
# LiquidFlow backend — local verification script.
#
# Run this on a machine with the Rust toolchain and Docker (for Postgres).
# It compiles with the strictest settings, runs the unit + property tests, and
# applies the SQL schema with its invariant tests against a real Postgres.
#
# Expected outcome: every step prints OK / "test result: ok" and the script
# exits 0. Any failure exits non-zero.

set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/5  Formatting check (cargo fmt --check)"
cargo fmt --check

echo "==> 2/5  Lints (clippy, warnings denied)"
cargo clippy --all-targets -- -D warnings

echo "==> 3/5  Build (release)"
cargo build --release

echo "==> 4/5  Unit + property tests"
# Includes money round-trip/inverse properties and all auth checks.
cargo test --all

echo "==> 5/5  Database schema + invariant tests"
# Spin up a throwaway Postgres, apply schema, run the invariant assertions.
CONTAINER=lf_pg_verify
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16 >/dev/null
echo "    waiting for postgres..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$CONTAINER" psql -U postgres -c "CREATE DATABASE liquidflow;" >/dev/null
docker exec -i "$CONTAINER" psql -U postgres -d liquidflow < migrations/0001_init.sql >/dev/null
echo "    schema applied; running invariant tests..."
docker exec -i "$CONTAINER" psql -U postgres -d liquidflow -v ON_ERROR_STOP=1 \
  < migrations/0001_invariants_test.sql | grep -E "PASS|PASSED"
docker rm -f "$CONTAINER" >/dev/null

echo
echo "==> ALL VERIFICATION STEPS PASSED"
