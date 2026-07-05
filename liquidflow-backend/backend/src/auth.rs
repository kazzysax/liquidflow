//! Wallet-based authentication (Sign-In With Ethereum style).
//!
//! Non-custodial principle: we never receive or store a private key. The user
//! proves control of their wallet by signing a one-time, server-issued nonce.
//! We recover the signer address from the signature and compare it to the
//! claimed address. Nothing about this flow can move funds.
//!
//! Security properties enforced here:
//!  * Nonces are single-use (consumed_at) and time-limited (expires_at) → no replay.
//!  * Session tokens are random 256-bit values; only their SHA-256 hash is stored,
//!    so a database leak does not yield usable tokens.
//!  * Addresses are normalised (lowercased) before any comparison or storage.

use alloy_primitives::{Address, B256};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::str::FromStr;
use time::{Duration, OffsetDateTime};

/// How long an unconsumed sign-in challenge remains valid.
pub const CHALLENGE_TTL: Duration = Duration::minutes(5);
/// How long a session is valid before re-authentication is required.
pub const SESSION_TTL: Duration = Duration::hours(24);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthError {
    #[error("address is not a valid EVM address")]
    InvalidAddress,
    #[error("signature is malformed")]
    MalformedSignature,
    #[error("signature does not match the claimed address")]
    SignatureMismatch,
    #[error("challenge not found or already used")]
    ChallengeInvalid,
    #[error("challenge has expired")]
    ChallengeExpired,
}

/// Normalise an EVM address to lowercase hex with 0x prefix. Returns an error if
/// the input is not a syntactically valid 20-byte address.
pub fn normalise_address(input: &str) -> Result<String, AuthError> {
    let addr = Address::from_str(input.trim()).map_err(|_| AuthError::InvalidAddress)?;
    // Lowercase canonical form for consistent storage and comparison.
    Ok(format!("{:#x}", addr))
}

/// A freshly issued sign-in challenge to be stored and returned to the client.
#[derive(Debug, Clone)]
pub struct Challenge {
    pub wallet_address: String,
    pub nonce: String,
    pub issued_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
}

/// Generate a new challenge for a wallet address. The `nonce` is a 256-bit random
/// hex string; the human-readable message the wallet signs is built by
/// [`siwe_message`] so the user sees what they are signing.
pub fn new_challenge(wallet_address: &str) -> Result<Challenge, AuthError> {
    let wallet = normalise_address(wallet_address)?;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let nonce = hex::encode(bytes);
    let now = OffsetDateTime::now_utc();
    Ok(Challenge {
        wallet_address: wallet,
        nonce,
        issued_at: now,
        expires_at: now + CHALLENGE_TTL,
    })
}

/// Build the exact human-readable message the wallet is asked to sign. Including
/// the domain and nonce binds the signature to this app and this one challenge.
pub fn siwe_message(domain: &str, wallet_address: &str, nonce: &str) -> String {
    format!(
        "{domain} wants you to sign in with your wallet:\n{wallet_address}\n\n\
         Sign in to LiquidFlow. This request will not move any funds.\n\n\
         Nonce: {nonce}"
    )
}

/// Verify a signature over the SIWE message and confirm it was produced by the
/// private key controlling `claimed_address`. Returns Ok(()) only on a match.
///
/// `signature` is the 65-byte (r‖s‖v) hex string returned by the wallet.
pub fn verify_signature(
    message: &str,
    signature_hex: &str,
    claimed_address: &str,
) -> Result<(), AuthError> {
    // NOTE (verify against your pinned alloy version): the exact path for the
    // signature type and the recover-from-message method has changed across
    // alloy releases. As of alloy 0.8 this is `alloy_primitives::Signature` (or
    // `alloy_signer::Signature`) with `recover_address_from_msg`. Confirm the
    // import and method name with `cargo build`; the *logic* (recover signer,
    // compare to claimed address) is correct regardless of the surface API.
    use alloy_signer::Signature;

    let claimed = normalise_address(claimed_address)?;

    let sig_bytes = hex::decode(signature_hex.trim_start_matches("0x"))
        .map_err(|_| AuthError::MalformedSignature)?;
    let signature =
        Signature::try_from(sig_bytes.as_slice()).map_err(|_| AuthError::MalformedSignature)?;

    // EIP-191 personal_sign prefix is applied by recover_address_from_msg.
    let recovered = signature
        .recover_address_from_msg(message.as_bytes())
        .map_err(|_| AuthError::SignatureMismatch)?;

    let recovered_norm = format!("{:#x}", recovered);
    if recovered_norm == claimed {
        Ok(())
    } else {
        Err(AuthError::SignatureMismatch)
    }
}

/// Validate challenge timing/usage. The caller supplies the stored challenge
/// fields; this enforces single-use and expiry without touching the DB so it can
/// be unit-tested in isolation.
pub fn check_challenge_usable(
    consumed_at: Option<OffsetDateTime>,
    expires_at: OffsetDateTime,
    now: OffsetDateTime,
) -> Result<(), AuthError> {
    if consumed_at.is_some() {
        return Err(AuthError::ChallengeInvalid);
    }
    if now > expires_at {
        return Err(AuthError::ChallengeExpired);
    }
    Ok(())
}

/// A newly minted session. `token` is returned to the client exactly once;
/// `token_hash` is what we persist. The plaintext token is never stored.
pub struct NewSession {
    pub token: String,
    pub token_hash: [u8; 32],
    pub expires_at: OffsetDateTime,
}

/// Create a session token: 256 bits of randomness, hex-encoded. We store only the
/// SHA-256 hash, so a DB compromise cannot reveal a usable bearer token.
pub fn new_session() -> NewSession {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    let token_hash = hash_token(&token);
    NewSession {
        token,
        token_hash,
        expires_at: OffsetDateTime::now_utc() + SESSION_TTL,
    }
}

/// Hash a session token for storage/lookup. Constant function of the input;
/// lookups hash the presented token and compare against stored hashes.
pub fn hash_token(token: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let out = hasher.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

/// Helper to turn a 0x-hex B256 into bytes, used by callers wiring DB columns.
pub fn b256_from_hex(s: &str) -> Option<B256> {
    B256::from_str(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDR: &str = "0x52908400098527886E0F7030069857D2E4169EE7";

    #[test]
    fn normalises_address_to_lowercase() {
        let n = normalise_address(ADDR).unwrap();
        assert_eq!(n, "0x52908400098527886e0f7030069857d2e4169ee7");
    }

    #[test]
    fn rejects_bad_address() {
        assert_eq!(normalise_address("not-an-address"), Err(AuthError::InvalidAddress));
        assert_eq!(normalise_address("0x1234"), Err(AuthError::InvalidAddress));
    }

    #[test]
    fn challenge_has_future_expiry_and_hex_nonce() {
        let c = new_challenge(ADDR).unwrap();
        assert!(c.expires_at > c.issued_at);
        assert_eq!(c.nonce.len(), 64); // 32 bytes hex
        assert!(c.nonce.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn message_binds_domain_and_nonce() {
        let m = siwe_message("liquidflow.xyz", ADDR, "abc123");
        assert!(m.contains("liquidflow.xyz"));
        assert!(m.contains("abc123"));
        assert!(m.contains("will not move any funds"));
    }

    #[test]
    fn consumed_challenge_is_rejected() {
        let now = OffsetDateTime::now_utc();
        let r = check_challenge_usable(Some(now), now + Duration::minutes(1), now);
        assert_eq!(r, Err(AuthError::ChallengeInvalid));
    }

    #[test]
    fn expired_challenge_is_rejected() {
        let now = OffsetDateTime::now_utc();
        let r = check_challenge_usable(None, now - Duration::seconds(1), now);
        assert_eq!(r, Err(AuthError::ChallengeExpired));
    }

    #[test]
    fn fresh_challenge_is_usable() {
        let now = OffsetDateTime::now_utc();
        let r = check_challenge_usable(None, now + Duration::minutes(1), now);
        assert!(r.is_ok());
    }

    #[test]
    fn session_token_is_not_stored_in_plaintext() {
        let s = new_session();
        // The stored hash must differ from the token and be reproducible.
        assert_ne!(s.token.as_bytes(), &s.token_hash);
        assert_eq!(hash_token(&s.token), s.token_hash);
        assert_eq!(s.token.len(), 64);
    }

    #[test]
    fn token_hash_is_deterministic() {
        assert_eq!(hash_token("abc"), hash_token("abc"));
        assert_ne!(hash_token("abc"), hash_token("abd"));
    }
}
