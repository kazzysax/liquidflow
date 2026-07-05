-- LiquidFlow backend — initial schema
-- Design principles enforced here:
--   * Non-custodial: we store NO private keys, NO seed phrases, NO custody of funds.
--     We only record state derived from on-chain events and user-signed intents.
--   * Append-only ledger: financial truth is never UPDATEd or DELETEd, only inserted.
--     Corrections are reversing entries, never edits.
--   * Every money-affecting row is traceable to an on-chain tx hash where applicable.

-- Required for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- USERS — identified by wallet address, not email/password (non-custodial auth)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Lowercased EVM address (0x + 40 hex) or chain-specific address.
    wallet_address  TEXT NOT NULL,
    -- CAIP-2 chain id the address was first verified on (e.g. 'eip155:8453').
    chain_namespace TEXT NOT NULL DEFAULT 'eip155',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Soft-deactivation only; we never hard-delete user history.
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT users_wallet_unique UNIQUE (wallet_address)
);

-- ---------------------------------------------------------------------------
-- AUTH CHALLENGES — SIWE-style nonce challenges for wallet sign-in.
-- A nonce is single-use and short-lived; consumed_at prevents replay.
-- ---------------------------------------------------------------------------
CREATE TABLE auth_challenges (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address  TEXT NOT NULL,
    nonce           TEXT NOT NULL UNIQUE,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ
);
CREATE INDEX idx_auth_challenges_wallet ON auth_challenges (wallet_address);
CREATE INDEX idx_auth_challenges_expiry ON auth_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- SESSIONS — opaque server-side session tokens (hashed at rest).
-- We store only a hash of the token, never the token itself.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users (id),
    token_hash      BYTEA NOT NULL UNIQUE,      -- SHA-256 of the session token
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    -- Forensics for anomaly detection (never used for trust decisions alone).
    created_ip      INET,
    user_agent      TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- WISE UNLOCK — lock plans. The authoritative lock lives ON-CHAIN; this table
-- mirrors it for fast reads and UX. contract_address + onchain_lock_id are the
-- source of truth pointer. We never move these funds; the contract does.
-- ---------------------------------------------------------------------------
CREATE TYPE lock_type AS ENUM ('fixed_term', 'interval_release', 'flexible');
CREATE TYPE lock_status AS ENUM ('pending', 'active', 'completed', 'cancelled');

CREATE TABLE locks (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users (id),
    lock_type         lock_type NOT NULL,
    status            lock_status NOT NULL DEFAULT 'pending',
    -- Amounts are stored as base-unit integers in TEXT to avoid float error and
    -- to hold 256-bit values that exceed BIGINT. Never use floating point for money.
    total_amount      TEXT NOT NULL,
    asset_symbol      TEXT NOT NULL,          -- e.g. 'USDC'
    chain_id          TEXT NOT NULL,          -- CAIP-2, e.g. 'eip155:8453'
    -- On-chain anchors (NULL until the create tx confirms).
    contract_address  TEXT,
    onchain_lock_id   TEXT,
    create_tx_hash    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at      TIMESTAMPTZ,
    CONSTRAINT locks_amount_positive CHECK (total_amount ~ '^[0-9]+$')
);
CREATE INDEX idx_locks_user ON locks (user_id);
CREATE INDEX idx_locks_status ON locks (status);

-- Tranches define the scheduled releases of a lock.
CREATE TYPE tranche_status AS ENUM ('locked', 'unlockable', 'released');

CREATE TABLE lock_tranches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lock_id         UUID NOT NULL REFERENCES locks (id),
    seq             INTEGER NOT NULL,          -- 1-based ordering
    amount          TEXT NOT NULL,
    unlock_at       TIMESTAMPTZ,               -- NULL for flexible locks
    status          tranche_status NOT NULL DEFAULT 'locked',
    release_tx_hash TEXT,
    released_at     TIMESTAMPTZ,
    CONSTRAINT tranche_amount_positive CHECK (amount ~ '^[0-9]+$'),
    CONSTRAINT tranche_seq_unique UNIQUE (lock_id, seq)
);
CREATE INDEX idx_tranches_lock ON lock_tranches (lock_id);
CREATE INDEX idx_tranches_status ON lock_tranches (status);

-- ---------------------------------------------------------------------------
-- POTLOCK — public fundraisers. Donations are read from chain, never custodied.
-- We only display the deposit address (a contract or user-owned receive address)
-- and the running total derived from confirmed on-chain transfers.
-- ---------------------------------------------------------------------------
CREATE TYPE fundraiser_status AS ENUM ('active', 'paused', 'completed');

CREATE TABLE fundraisers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id      UUID NOT NULL REFERENCES users (id),
    slug              TEXT NOT NULL UNIQUE,    -- public URL: /pot/<slug>
    title             TEXT NOT NULL,
    description       TEXT NOT NULL,
    goal_amount       TEXT NOT NULL,           -- USD-equiv display target (integer cents)
    -- Address donations are sent to. Any supported chain may donate to it.
    deposit_address   TEXT NOT NULL,
    status            fundraiser_status NOT NULL DEFAULT 'active',
    is_public         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fundraiser_goal_positive CHECK (goal_amount ~ '^[0-9]+$')
);
CREATE INDEX idx_fundraisers_organizer ON fundraisers (organizer_id);
CREATE INDEX idx_fundraisers_status ON fundraisers (status);

-- Donations: amounts only, anonymized by design (no donor identity is exposed
-- in any public API; we store the source tx hash for verification/reconciliation
-- but never surface a donor address publicly).
CREATE TABLE donations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fundraiser_id   UUID NOT NULL REFERENCES fundraisers (id),
    amount          TEXT NOT NULL,             -- base units of the asset received
    asset_symbol    TEXT NOT NULL,
    chain_id        TEXT NOT NULL,
    -- usd_equiv stored as integer cents at time of confirmation, for the public total.
    usd_equiv_cents BIGINT NOT NULL,
    source_tx_hash  TEXT NOT NULL UNIQUE,      -- dedupe: one row per on-chain tx
    confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT donation_amount_positive CHECK (amount ~ '^[0-9]+$')
);
CREATE INDEX idx_donations_fundraiser ON donations (fundraiser_id);

-- ---------------------------------------------------------------------------
-- LEDGER — append-only, double-entry audit log of every money-relevant event.
-- This table is INSERT-ONLY. A trigger forbids UPDATE and DELETE. Corrections
-- are made by inserting compensating entries that reference the original.
-- ---------------------------------------------------------------------------
CREATE TYPE ledger_event AS ENUM (
    'lock_created', 'tranche_released', 'lock_cancelled',
    'donation_received', 'fundraiser_created'
);

CREATE TABLE ledger_entries (
    id              BIGSERIAL PRIMARY KEY,
    event           ledger_event NOT NULL,
    user_id         UUID REFERENCES users (id),
    -- Polymorphic reference to the subject row (lock, tranche, fundraiser, donation).
    subject_type    TEXT NOT NULL,
    subject_id      UUID NOT NULL,
    amount          TEXT,                      -- base units, nullable for non-amount events
    asset_symbol    TEXT,
    chain_id        TEXT,
    tx_hash         TEXT,
    -- Idempotency: the same logical event can only be written once.
    idempotency_key TEXT NOT NULL UNIQUE,
    -- For corrections: points at the entry being reversed (NULL otherwise).
    reverses_id     BIGINT REFERENCES ledger_entries (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_ledger_user ON ledger_entries (user_id);
CREATE INDEX idx_ledger_subject ON ledger_entries (subject_type, subject_id);
CREATE INDEX idx_ledger_created ON ledger_entries (created_at);

-- Enforce append-only: block UPDATE and DELETE on the ledger at the DB level.
CREATE OR REPLACE FUNCTION ledger_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_no_update
    BEFORE UPDATE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

CREATE TRIGGER trg_ledger_no_delete
    BEFORE DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
