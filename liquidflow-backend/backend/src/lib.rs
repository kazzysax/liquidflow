//! LiquidFlow backend — non-custodial gated-payment infrastructure.
//!
//! Module map:
//!   money — integer base-unit money primitive (no floats, checked arithmetic)
//!   auth  — wallet sign-in (SIWE), nonce challenges, hashed sessions
//!   api   — HTTP routes wiring the above

pub mod api;
pub mod auth;
pub mod money;
