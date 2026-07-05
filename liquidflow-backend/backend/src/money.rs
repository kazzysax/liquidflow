//! Money handling for LiquidFlow.
//!
//! Core rule: money is NEVER a floating-point number. We represent amounts as
//! unsigned 256-bit integers in base units (e.g. wei, or the smallest unit of a
//! token). All arithmetic is *checked* — overflow returns an error rather than
//! silently wrapping, because a wrapped balance is a stolen or vanished balance.

use alloy_primitives::U256;
use std::fmt;
use std::str::FromStr;

/// An amount of a single asset, in its smallest indivisible base unit.
///
/// Invariants:
///  * always >= 0 (the type is unsigned, so this is structural)
///  * stored exactly; no precision loss is possible
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Amount(U256);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AmountError {
    #[error("amount string is empty")]
    Empty,
    #[error("amount contains non-digit characters")]
    NotADigitString,
    #[error("amount overflows 256-bit range")]
    Overflow,
    #[error("arithmetic overflow")]
    ArithmeticOverflow,
    #[error("arithmetic underflow (result would be negative)")]
    Underflow,
}

impl Amount {
    pub const ZERO: Amount = Amount(U256::ZERO);

    /// Construct from a `u128` base-unit value.
    pub fn from_u128(v: u128) -> Self {
        Amount(U256::from(v))
    }

    /// Parse a base-unit decimal string (e.g. "1000000"). Rejects anything that
    /// is not a pure non-negative integer — no signs, no decimals, no spaces.
    pub fn parse_base_units(s: &str) -> Result<Self, AmountError> {
        if s.is_empty() {
            return Err(AmountError::Empty);
        }
        if !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(AmountError::NotADigitString);
        }
        U256::from_str(s).map(Amount).map_err(|_| AmountError::Overflow)
    }

    /// Checked addition. Returns Err on overflow rather than wrapping.
    pub fn checked_add(self, other: Amount) -> Result<Amount, AmountError> {
        self.0
            .checked_add(other.0)
            .map(Amount)
            .ok_or(AmountError::ArithmeticOverflow)
    }

    /// Checked subtraction. Returns Err if the result would be negative.
    pub fn checked_sub(self, other: Amount) -> Result<Amount, AmountError> {
        self.0
            .checked_sub(other.0)
            .map(Amount)
            .ok_or(AmountError::Underflow)
    }

    pub fn is_zero(self) -> bool {
        self.0.is_zero()
    }

    /// Render back to a canonical base-unit decimal string for storage.
    pub fn to_base_units(self) -> String {
        self.0.to_string()
    }
}

impl fmt::Display for Amount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn parses_plain_integer() {
        assert_eq!(
            Amount::parse_base_units("1000000").unwrap().to_base_units(),
            "1000000"
        );
    }

    #[test]
    fn rejects_negative() {
        assert_eq!(
            Amount::parse_base_units("-5"),
            Err(AmountError::NotADigitString)
        );
    }

    #[test]
    fn rejects_decimal() {
        assert_eq!(
            Amount::parse_base_units("1.5"),
            Err(AmountError::NotADigitString)
        );
    }

    #[test]
    fn rejects_empty_and_spaces() {
        assert_eq!(Amount::parse_base_units(""), Err(AmountError::Empty));
        assert_eq!(
            Amount::parse_base_units(" 10"),
            Err(AmountError::NotADigitString)
        );
    }

    #[test]
    fn sub_underflow_is_error_not_wrap() {
        let a = Amount::from_u128(5);
        let b = Amount::from_u128(10);
        assert_eq!(a.checked_sub(b), Err(AmountError::Underflow));
    }

    // Property: round-tripping any u128 through parse/serialize is lossless.
    proptest! {
        #[test]
        fn roundtrip_lossless(v in any::<u128>()) {
            let a = Amount::from_u128(v);
            let s = a.to_base_units();
            let b = Amount::parse_base_units(&s).unwrap();
            prop_assert_eq!(a, b);
        }

        // Property: add then sub the same value returns the original (no drift).
        #[test]
        fn add_sub_inverse(a in any::<u128>(), b in any::<u128>()) {
            let aa = Amount::from_u128(a);
            let bb = Amount::from_u128(b);
            let sum = aa.checked_add(bb).unwrap();
            let back = sum.checked_sub(bb).unwrap();
            prop_assert_eq!(aa, back);
        }
    }
}
