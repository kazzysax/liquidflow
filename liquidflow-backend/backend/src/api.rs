//! HTTP API skeleton for LiquidFlow.
//!
//! This wires the foundation routes only:
//!   GET  /health                 — liveness
//!   POST /auth/challenge         — issue a sign-in nonce for a wallet
//!   POST /auth/verify            — verify a signed challenge, open a session
//!   GET  /me                     — example protected route (requires session)
//!
//! Per-system routes (locks, fundraisers) are added in their own modules once
//! the foundation is in place. Nothing here ever holds keys or moves funds.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth;

/// Application state shared across handlers. In a full build this holds the
/// sqlx PgPool and config; kept minimal here for the foundation.
#[derive(Clone)]
pub struct AppState {
    pub domain: Arc<str>,
}

/// Uniform JSON error envelope. We deliberately keep messages generic on the
/// wire to avoid leaking internal detail to callers.
#[derive(Serialize)]
struct ApiError {
    error: String,
}

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(ApiError { error: msg.to_string() })).into_response()
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/auth/challenge", post(auth_challenge))
        .route("/auth/verify", post(auth_verify))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "status": "ok" })))
}

// ----- POST /auth/challenge -------------------------------------------------

#[derive(Deserialize)]
struct ChallengeRequest {
    wallet_address: String,
}

#[derive(Serialize)]
struct ChallengeResponse {
    nonce: String,
    message: String,
    expires_at: String,
}

async fn auth_challenge(
    State(state): State<AppState>,
    Json(body): Json<ChallengeRequest>,
) -> Response {
    let challenge = match auth::new_challenge(&body.wallet_address) {
        Ok(c) => c,
        Err(_) => return err(StatusCode::BAD_REQUEST, "invalid wallet address"),
    };

    // NOTE: persistence elided in the skeleton. A full impl INSERTs the challenge
    // (wallet, nonce, expires_at) so /auth/verify can look it up and consume it.

    let message = auth::siwe_message(&state.domain, &challenge.wallet_address, &challenge.nonce);
    let resp = ChallengeResponse {
        nonce: challenge.nonce,
        message,
        expires_at: challenge.expires_at.to_string(),
    };
    (StatusCode::OK, Json(resp)).into_response()
}

// ----- POST /auth/verify ----------------------------------------------------

#[derive(Deserialize)]
struct VerifyRequest {
    wallet_address: String,
    nonce: String,
    signature: String,
}

#[derive(Serialize)]
struct VerifyResponse {
    session_token: String,
    expires_at: String,
}

async fn auth_verify(State(state): State<AppState>, Json(body): Json<VerifyRequest>) -> Response {
    // In a full impl: look up the stored challenge by (wallet, nonce), then run
    // check_challenge_usable(consumed_at, expires_at, now). Here we reconstruct
    // the message and verify the signature to demonstrate the core check.
    let wallet = match auth::normalise_address(&body.wallet_address) {
        Ok(w) => w,
        Err(_) => return err(StatusCode::BAD_REQUEST, "invalid wallet address"),
    };

    let message = auth::siwe_message(&state.domain, &wallet, &body.nonce);

    match auth::verify_signature(&message, &body.signature, &wallet) {
        Ok(()) => {}
        Err(_) => return err(StatusCode::UNAUTHORIZED, "signature verification failed"),
    }

    // Mint a session. A full impl marks the challenge consumed and INSERTs the
    // session row (user_id, token_hash, expires_at) before returning.
    let session = auth::new_session();
    let resp = VerifyResponse {
        session_token: session.token,
        expires_at: session.expires_at.to_string(),
    };
    (StatusCode::OK, Json(resp)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_request_deserializes() {
        let j = r#"{"wallet_address":"0x52908400098527886E0F7030069857D2E4169EE7"}"#;
        let parsed: ChallengeRequest = serde_json::from_str(j).unwrap();
        assert!(parsed.wallet_address.starts_with("0x"));
    }

    #[test]
    fn error_envelope_serializes() {
        let e = ApiError { error: "x".into() };
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(s, r#"{"error":"x"}"#);
    }
}
