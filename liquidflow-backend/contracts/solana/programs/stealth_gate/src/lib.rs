// Liquid Flow — Stealth Deposit Gate (Solana / Anchor)
//
// Purpose: private, NON-CUSTODIAL, per-payment deposits on Solana WITHOUT the
// ed25519 raw-scalar problem. The EIP-5564 stealth scheme (see api/_lib/crypto.js)
// works on Ethereum because an EVM private key is a raw scalar, but a Solana wallet
// key is a *seed* that is hashed+clamped into the scalar — so a stealth-derived
// scalar has no importable seed and funds sent to such an address are effectively
// unspendable with standard tooling. This program sidesteps that entirely:
//
//   * Each payment gets a fresh, program-derived deposit address (a vault PDA seeded
//     by the merchant's gate + the paymentId). Outsiders can't enumerate a merchant's
//     deposits, so it stays unlinkable at deposit time — the privacy property we want.
//   * Spendability is enforced by THIS PROGRAM signing the vault PDA via invoke_signed,
//     not by anyone reconstructing a private key. Only the merchant's own authority can
//     trigger a sweep, and it can sweep to ANY destination the merchant names (use a
//     fresh address to keep the settlement unlinkable to the merchant's identity).
//   * Liquid Flow is never the authority and has no instruction that moves funds. It
//     only watches the vault balance to confirm payments.
//
// VERIFICATION STATUS: review-grade. Build/test locally with Anchor (`anchor build`
// / `anchor test`) — the toolchain is network-blocked in the authoring sandbox, so
// this has NOT been compiled here. Must pass the GO-LIVE Phase 5 audit before mainnet.
//
// SECURITY NOTE (critical): after deploy, the program UPGRADE AUTHORITY must be
// burned or held by a builder/guardian multisig — never by Liquid Flow. A retained
// upgrade authority could replace this logic and is the only real backdoor on Solana.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("Liqu1dF1owStea1thGate1111111111111111111111");

/// paymentId is used as a PDA seed; Solana caps each seed at 32 bytes. Our ids
/// ("pay_"/"don_" + 16 hex = 20 bytes) fit comfortably.
pub const MAX_PAYMENT_ID_LEN: usize = 32;

#[program]
pub mod stealth_gate {
    use super::*;

    /// Create a merchant's gate (one per merchant). `authority` is the merchant's own
    /// Solana pubkey — the ONLY key that can ever sweep this gate's deposits. Liquid
    /// Flow is deliberately not a parameter and cannot be the authority.
    pub fn init_gate(ctx: Context<InitGate>, authority: Pubkey) -> Result<()> {
        require!(authority != Pubkey::default(), GateErr::ZeroAddress);
        let g = &mut ctx.accounts.gate;
        g.authority = authority;
        g.bump = ctx.bumps.gate;
        Ok(())
    }

    /// Sweep a single payment's deposit vault to a merchant-chosen destination.
    ///
    /// Auth: the transaction must be signed by the gate's `authority` (the merchant).
    /// Non-custodial: no other signer — not LF, not a guardian — can move these funds.
    /// The vault PDA is seeded by (gate, payment_id), so this can only touch the vault
    /// for exactly this payment. Sweeps the FULL balance (stealth vaults are single-use).
    pub fn sweep(ctx: Context<Sweep>, payment_id: Vec<u8>) -> Result<()> {
        require!(payment_id.len() <= MAX_PAYMENT_ID_LEN, GateErr::PaymentIdTooLong);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.gate.authority,
            GateErr::NotAuthority
        );

        let amount = ctx.accounts.vault.lamports();
        require!(amount > 0, GateErr::NothingToSweep);

        // Move the vault's lamports out via a system-program CPI signed by the vault's
        // PDA seeds. Effects/authorization are all checked above (no reentrancy surface
        // on a single system transfer, but we still finish checks before the CPI).
        let gate_key = ctx.accounts.gate.key();
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            gate_key.as_ref(),
            payment_id.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer_seeds: &[&[&[u8]]] = &[vault_seeds];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
            },
            signer_seeds,
        );
        system_program::transfer(cpi, amount)?;
        emit!(Swept {
            gate: gate_key,
            destination: ctx.accounts.destination.key(),
            amount,
        });
        Ok(())
    }
}

// ------------------------------- State ------------------------------------- //
#[account]
pub struct Gate {
    pub authority: Pubkey, // the merchant; only signer that can sweep
    pub bump: u8,
}

#[event]
pub struct Swept {
    pub gate: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

// ----------------------------- Contexts ------------------------------------ //
#[derive(Accounts)]
pub struct InitGate<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 1,
        seeds = [b"gate", authority_seed.key().as_ref()],
        bump
    )]
    pub gate: Account<'info, Gate>,
    /// CHECK: used only as a PDA seed so a merchant's gate address is derived from
    /// their own authority pubkey. The stored authority comes from the instruction arg.
    pub authority_seed: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(payment_id: Vec<u8>)]
pub struct Sweep<'info> {
    #[account(seeds = [b"gate", gate.authority.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    /// CHECK: SOL-holding deposit PDA for this payment; validated by seeds. It is a
    /// plain system-owned account that received the payer's transfer.
    #[account(
        mut,
        seeds = [b"vault", gate.key().as_ref(), payment_id.as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    /// CHECK: merchant-chosen payout destination; any address is allowed (use a fresh
    /// one to keep settlement unlinkable). Funds can only leave via this signed sweep.
    #[account(mut)]
    pub destination: AccountInfo<'info>,
    /// The merchant's authority — must match gate.authority and sign the tx.
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ------------------------------- Errors ------------------------------------ //
#[error_code]
pub enum GateErr {
    #[msg("zero address")] ZeroAddress,
    #[msg("caller is not the gate authority")] NotAuthority,
    #[msg("payment id too long for a PDA seed")] PaymentIdTooLong,
    #[msg("nothing to sweep")] NothingToSweep,
}
