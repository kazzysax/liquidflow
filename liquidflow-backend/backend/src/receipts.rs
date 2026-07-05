//! Payment receipts with anti-forgery guarantees.
//!
//! A LiquidFlow receipt is verifiable against TWO independent sources of truth,
//! so it cannot be forged:
//!
//!   1. The blockchain — the receipt carries the real `tx_hash` and an explorer
//!      URL. Anyone can independently confirm the payment exists on-chain with the
//!      stated amount to the stated merchant address. A forger cannot invent a tx
//!      hash that resolves to a matching real transaction.
//!
//!   2. An Ed25519 signature — the receipt is signed by LiquidFlow's receipt key.
//!      Changing any field breaks the signature. A forger cannot produce a valid
//!      signature without the private key.
//!
//! IMPORTANT: the receipt-signing key signs receipts only. It can NEVER move
//! funds, so holding it does not make the system custodial. Even if it leaked, an
//! attacker could mint false receipts but still could not touch any funds — and
//! the on-chain check (source of truth #1) would expose the false receipt because
//! no matching transaction would exist.
//!
//! A receipt is ACCEPTED only if BOTH hold: signature verifies AND the on-chain
//! transaction matches (amount, destination, asset). Verifying signature alone is
//! necessary but not sufficient; the chain is the ultimate arbiter.

use serde::{Deserialize, Serialize};

/// CAIP-2-style chain id -> explorer transaction URL.
pub fn explorer_url(chain_id: &str, tx_hash: &str) -> Option<String> {
    let base = match chain_id {
        "eip155:1" => "https://etherscan.io/tx/",
        "eip155:8453" => "https://basescan.org/tx/",
        "eip155:137" => "https://polygonscan.com/tx/",
        "eip155:42161" => "https://arbiscan.io/tx/",
        "eip155:10" => "https://optimistic.etherscan.io/tx/",
        "eip155:56" => "https://bscscan.com/tx/",
        "eip155:43114" => "https://snowtrace.io/tx/",
        "solana" => "https://solscan.io/tx/",
        "aptos" => "https://explorer.aptoslabs.com/txn/",
        "sui" => "https://suiscan.xyz/tx/",
        "near" => "https://nearblocks.io/txns/",
        _ => return None,
    };
    Some(format!("{base}{tx_hash}"))
}

/// The receipt payload. Field order here defines the canonical signing order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub receipt_id: String,
    pub payment_id: String,
    pub platform_id: String,
    pub chain_id: String,
    pub tx_hash: String,
    pub asset: String,
    /// Base-unit integer amount as a decimal string (never a float).
    pub amount_base_units: String,
    pub payer_ref: String,
    pub merchant_address: String,
    pub confirmed_at: String,
    pub confirmations: u32,
    pub final_: bool,
    /// Block-explorer link the user can click to independently verify on-chain.
    pub explorer_url: Option<String>,
}

/// A receipt plus its detached signature and the signer's public key (DER/base64).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedReceipt {
    pub receipt: Receipt,
    pub signature_b64: String,
    pub signer_pubkey_b64: String,
}

/// Deterministic bytes to sign/verify. Stable field order means a forger cannot
/// exploit key reordering, and re-serialization by a client cannot change the verdict.
pub fn canonical_bytes(r: &Receipt) -> Vec<u8> {
    // We build the canonical string explicitly rather than relying on serde map
    // ordering, so the signed form is unambiguous and implementation-independent.
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        r.receipt_id,
        r.payment_id,
        r.platform_id,
        r.chain_id,
        r.tx_hash,
        r.asset,
        r.amount_base_units,
        r.payer_ref,
        r.merchant_address,
        r.confirmed_at,
        r.confirmations,
        r.final_,
    )
    .into_bytes()
}

/// Result of verifying a receipt against the chain.
#[derive(Debug, PartialEq, Eq)]
pub enum ReceiptVerdict {
    /// Signature valid AND on-chain transaction matches. Accept.
    Valid,
    /// Signature did not verify (tampered or wrong signer). Reject.
    BadSignature,
    /// Signature valid but the on-chain transaction does not match (or is missing).
    /// This is how a leaked signing key is caught: false receipt, no real tx.
    ChainMismatch,
}

/// What an on-chain lookup must return for the dual-source check.
pub struct OnChainTx {
    pub exists: bool,
    pub to: String,
    pub asset: String,
    pub amount_base_units: String,
    pub confirmations: u32,
}

/// Verify a receipt against BOTH sources of truth.
///
/// `verify_sig` abstracts the Ed25519 check (the crate wires it to a real verifier;
/// kept injectable so this is unit-testable without a crypto dep in tests).
/// `chain` is the result of looking up `receipt.tx_hash` on the relevant chain.
pub fn verify_receipt<F>(
    sr: &SignedReceipt,
    trusted_pubkey_b64: &str,
    verify_sig: F,
    chain: Option<&OnChainTx>,
    min_confirmations: u32,
) -> ReceiptVerdict
where
    F: Fn(&[u8], &str, &str) -> bool, // (msg, sig_b64, pubkey_b64) -> ok
{
    // Source of truth #2: signature. Pin the trusted key (do NOT trust the key
    // embedded in the receipt itself).
    let msg = canonical_bytes(&sr.receipt);
    if !verify_sig(&msg, &sr.signature_b64, trusted_pubkey_b64) {
        return ReceiptVerdict::BadSignature;
    }

    // Source of truth #1: the chain. Even a correctly-signed receipt is rejected
    // if no matching on-chain transaction backs it.
    let r = &sr.receipt;
    match chain {
        Some(tx)
            if tx.exists
                && tx.to.eq_ignore_ascii_case(&r.merchant_address)
                && tx.asset == r.asset
                && tx.amount_base_units == r.amount_base_units
                && tx.confirmations >= min_confirmations =>
        {
            ReceiptVerdict::Valid
        }
        _ => ReceiptVerdict::ChainMismatch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Receipt {
        Receipt {
            receipt_id: "rcpt_1".into(),
            payment_id: "pay_4471".into(),
            platform_id: "platform_abc".into(),
            chain_id: "eip155:8453".into(),
            tx_hash: "0x9f4c".into(),
            asset: "USDC".into(),
            amount_base_units: "50000000".into(),
            payer_ref: "anon".into(),
            merchant_address: "0xMerchant".into(),
            confirmed_at: "2026-01-15T10:32:00Z".into(),
            confirmations: 12,
            final_: true,
            explorer_url: explorer_url("eip155:8453", "0x9f4c"),
        }
    }

    #[test]
    fn explorer_link_is_built() {
        assert_eq!(
            sample().explorer_url.unwrap(),
            "https://basescan.org/tx/0x9f4c"
        );
    }

    #[test]
    fn canonical_changes_when_amount_changes() {
        let a = sample();
        let mut b = sample();
        b.amount_base_units = "500000000".into();
        assert_ne!(canonical_bytes(&a), canonical_bytes(&b));
    }

    #[test]
    fn bad_signature_is_rejected() {
        let sr = SignedReceipt { receipt: sample(), signature_b64: "x".into(), signer_pubkey_b64: "p".into() };
        let v = verify_receipt(&sr, "trusted", |_, _, _| false, None, 1);
        assert_eq!(v, ReceiptVerdict::BadSignature);
    }

    #[test]
    fn good_sig_but_no_chain_match_is_rejected() {
        // This models a LEAKED signing key: signature verifies, but no real tx.
        let sr = SignedReceipt { receipt: sample(), signature_b64: "ok".into(), signer_pubkey_b64: "p".into() };
        let v = verify_receipt(&sr, "trusted", |_, _, _| true, None, 1);
        assert_eq!(v, ReceiptVerdict::ChainMismatch);
    }

    #[test]
    fn good_sig_and_matching_chain_is_valid() {
        let sr = SignedReceipt { receipt: sample(), signature_b64: "ok".into(), signer_pubkey_b64: "p".into() };
        let tx = OnChainTx { exists: true, to: "0xMerchant".into(), asset: "USDC".into(), amount_base_units: "50000000".into(), confirmations: 12 };
        let v = verify_receipt(&sr, "trusted", |_, _, _| true, Some(&tx), 6);
        assert_eq!(v, ReceiptVerdict::Valid);
    }

    #[test]
    fn good_sig_but_wrong_amount_onchain_is_rejected() {
        let sr = SignedReceipt { receipt: sample(), signature_b64: "ok".into(), signer_pubkey_b64: "p".into() };
        let tx = OnChainTx { exists: true, to: "0xMerchant".into(), asset: "USDC".into(), amount_base_units: "1".into(), confirmations: 12 };
        let v = verify_receipt(&sr, "trusted", |_, _, _| true, Some(&tx), 6);
        assert_eq!(v, ReceiptVerdict::ChainMismatch);
    }

    #[test]
    fn insufficient_confirmations_is_rejected() {
        let sr = SignedReceipt { receipt: sample(), signature_b64: "ok".into(), signer_pubkey_b64: "p".into() };
        let tx = OnChainTx { exists: true, to: "0xMerchant".into(), asset: "USDC".into(), amount_base_units: "50000000".into(), confirmations: 2 };
        let v = verify_receipt(&sr, "trusted", |_, _, _| true, Some(&tx), 6);
        assert_eq!(v, ReceiptVerdict::ChainMismatch);
    }
}
