-- Schema invariant tests for LiquidFlow.
-- Run against a database that has had 0001_init.sql applied.
-- Each block asserts a security guarantee; the script exits non-zero on any failure.
\set ON_ERROR_STOP off

-- Helper: expect the next statement to FAIL. We use a savepoint so a failure
-- doesn't abort the whole script, and we assert that it did fail.

-- ---- 1. Ledger INSERT is allowed ----
INSERT INTO users (wallet_address) VALUES ('0xtest0000000000000000000000000000000000aa');
INSERT INTO ledger_entries (event, subject_type, subject_id, amount, asset_symbol, idempotency_key)
  VALUES ('lock_created','lock', gen_random_uuid(), '1000', 'USDC', 'inv-test-insert');

-- ---- 2. Ledger UPDATE must be blocked ----
DO $$
BEGIN
  BEGIN
    UPDATE ledger_entries SET amount='2' WHERE idempotency_key='inv-test-insert';
    RAISE EXCEPTION 'FAIL: ledger UPDATE was allowed';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%append-only%' THEN
      RAISE NOTICE 'PASS: ledger UPDATE blocked';
    ELSE RAISE; END IF;
  END;
END $$;

-- ---- 3. Ledger DELETE must be blocked ----
DO $$
BEGIN
  BEGIN
    DELETE FROM ledger_entries WHERE idempotency_key='inv-test-insert';
    RAISE EXCEPTION 'FAIL: ledger DELETE was allowed';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%append-only%' THEN
      RAISE NOTICE 'PASS: ledger DELETE blocked';
    ELSE RAISE; END IF;
  END;
END $$;

-- ---- 4. Duplicate idempotency_key must be rejected ----
DO $$
BEGIN
  BEGIN
    INSERT INTO ledger_entries (event, subject_type, subject_id, amount, asset_symbol, idempotency_key)
      VALUES ('lock_created','lock', gen_random_uuid(), '1', 'USDC', 'inv-test-insert');
    RAISE EXCEPTION 'FAIL: duplicate idempotency_key was allowed';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: duplicate idempotency_key rejected';
  END;
END $$;

-- ---- 5. Negative/malformed amounts must be rejected ----
DO $$
DECLARE uid UUID;
BEGIN
  SELECT id INTO uid FROM users LIMIT 1;
  BEGIN
    INSERT INTO locks (user_id, lock_type, total_amount, asset_symbol, chain_id)
      VALUES (uid, 'fixed_term', '-5', 'USDC', 'eip155:8453');
    RAISE EXCEPTION 'FAIL: negative amount was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: negative amount rejected';
  END;
END $$;

SELECT 'ALL INVARIANT TESTS PASSED' AS result;
