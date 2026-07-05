// Liquid Flow — Platform Wallet (Solana / Anchor)
//
// Non-custodial builder-owned smart account enforcing the shared guarantee set
// G1..G11 from multichain-wallet-design.md. Liquid Flow is never an owner and can
// never move funds. All controls are enforced on-chain.
//
// VERIFICATION STATUS: review-grade. Build/test locally with Anchor (the toolchain
// is network-blocked in the authoring sandbox). See README for commands.
//
// SECURITY NOTE (critical): the program UPGRADE AUTHORITY is the real backdoor on
// Solana. After deploy it MUST be set to a builder/guardian multisig or burned —
// never held by Liquid Flow. No instruction below can move funds, but a retained
// upgrade authority could replace this logic entirely.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("Liqu1dF1owP1atformWa11et11111111111111111111");

pub const MAX_OWNERS: usize = 10;
pub const SECONDS_PER_DAY: i64 = 86_400;

#[program]
pub mod platform_wallet {
    use super::*;

    /// Initialize the wallet PDA with the builder's owner set, threshold, guardian,
    /// and security parameters. Liquid Flow is intentionally not a parameter.
    pub fn initialize(
        ctx: Context<Initialize>,
        owners: Vec<Pubkey>,
        threshold: u8,
        guardian: Pubkey,        // Pubkey::default() (all-zero) disables guardian
        withdraw_delay: i64,
        large_amount: u64,
        allowlist_delay: i64,
        daily_limit: u64,
    ) -> Result<()> {
        require!(!owners.is_empty() && owners.len() <= MAX_OWNERS, WErr::InvalidOwners);
        require!(threshold as usize >= 1 && threshold as usize <= owners.len(), WErr::InvalidThreshold);
        // reject duplicate owners and the zero key
        for (i, o) in owners.iter().enumerate() {
            require!(*o != Pubkey::default(), WErr::ZeroAddress);
            for p in owners.iter().skip(i + 1) {
                require!(o != p, WErr::DuplicateOwner);
            }
        }
        let w = &mut ctx.accounts.wallet;
        w.owners = owners;
        w.threshold = threshold;
        w.guardian = guardian;
        w.withdraw_delay = withdraw_delay;
        w.large_amount = large_amount;
        w.allowlist_delay = allowlist_delay;
        w.daily_limit = daily_limit;
        w.paused = false;
        w.window_start = Clock::get()?.unix_timestamp;
        w.spent_in_window = 0;
        w.proposal_count = 0;
        w.bump = ctx.bumps.wallet;
        w.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    // ----- Deposit SOL into the wallet's vault PDA (settlement lands here) -----
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi, amount)?;
        Ok(())
    }

    // ----- Circuit breaker (G9) -----
    pub fn pause(ctx: Context<OwnerOrGuardian>) -> Result<()> {
        let w = &mut ctx.accounts.wallet;
        require!(is_owner(w, &ctx.accounts.signer.key()) || w.guardian == ctx.accounts.signer.key(), WErr::NotOwnerOrGuardian);
        w.paused = true;
        Ok(())
    }

    /// Unpause is quorum-gated: collect distinct owner approvals into a vote account.
    pub fn approve_unpause(ctx: Context<ApproveUnpause>) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        require!(is_owner(&ctx.accounts.wallet, &signer), WErr::NotOwner);
        let vote = &mut ctx.accounts.vote;
        require!(!vote.voters.contains(&signer), WErr::AlreadyApproved);
        vote.voters.push(signer);
        if vote.voters.len() as u8 >= ctx.accounts.wallet.threshold {
            ctx.accounts.wallet.paused = false;
            vote.voters.clear();
        }
        Ok(())
    }

    // ----- Allowlist with time-delay (G5, G6) -----
    pub fn propose_allowlist(ctx: Context<ProposeAllowlist>, dest: Pubkey) -> Result<()> {
        let w = &ctx.accounts.wallet;
        require!(is_owner(w, &ctx.accounts.signer.key()), WErr::NotOwner);
        require!(dest != Pubkey::default(), WErr::ZeroAddress);
        let entry = &mut ctx.accounts.entry;
        entry.dest = dest;
        entry.active_at = Clock::get()?.unix_timestamp + w.allowlist_delay;
        entry.pending = true;
        Ok(())
    }

    pub fn activate_allowlist(ctx: Context<MutateAllowlist>) -> Result<()> {
        let entry = &mut ctx.accounts.entry;
        require!(entry.pending, WErr::NothingPending);
        require!(Clock::get()?.unix_timestamp >= entry.active_at, WErr::PendingNotReady);
        entry.pending = false; // now active
        Ok(())
    }

    /// Owners or guardian can cancel a pending (not-yet-active) allowlist entry.
    pub fn cancel_allowlist(ctx: Context<CancelAllowlist>) -> Result<()> {
        let w = &ctx.accounts.wallet;
        let s = ctx.accounts.signer.key();
        require!(is_owner(w, &s) || w.guardian == s, WErr::NotOwnerOrGuardian);
        let entry = &mut ctx.accounts.entry;
        require!(entry.pending, WErr::NothingPending);
        entry.pending = false;
        entry.active_at = 0;
        entry.dest = Pubkey::default(); // invalidate
        Ok(())
    }

    // ----- Propose / approve / execute native (SOL) withdrawal (G2, G7, G11) -----
    pub fn propose_withdraw(ctx: Context<ProposeWithdraw>, to: Pubkey, amount: u64) -> Result<()> {
        let w = &mut ctx.accounts.wallet;
        require!(!w.paused, WErr::Paused);
        require!(is_owner(w, &ctx.accounts.signer.key()), WErr::NotOwner);
        // destination must be an active allowlist entry (G5)
        let entry = &ctx.accounts.entry;
        require!(entry.dest == to && !entry.pending && entry.active_at != 0
            && Clock::get()?.unix_timestamp >= entry.active_at, WErr::DestinationNotAllowed);

        let p = &mut ctx.accounts.proposal;
        p.wallet = w.key();
        p.to = to;
        p.amount = amount;
        p.executed = false;
        p.approvals = vec![ctx.accounts.signer.key()]; // proposer auto-approves
        // time-lock for large amounts (G7)
        let now = Clock::get()?.unix_timestamp;
        p.ready_at = if amount >= w.large_amount { now + w.withdraw_delay } else { now };
        w.proposal_count += 1;
        Ok(())
    }

    pub fn approve(ctx: Context<Approve>) -> Result<()> {
        let w = &ctx.accounts.wallet;
        require!(!w.paused, WErr::Paused);
        let s = ctx.accounts.signer.key();
        require!(is_owner(w, &s), WErr::NotOwner);
        let p = &mut ctx.accounts.proposal;
        require!(!p.executed, WErr::AlreadyExecuted);
        require!(!p.approvals.contains(&s), WErr::AlreadyApproved);
        p.approvals.push(s);
        // (re)set ready_at when quorum first reached handled at execute via amount check
        Ok(())
    }

    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        // Copy all needed values out of the borrowed accounts FIRST, so no borrow
        // of `wallet` is held across the CPI transfer (this is what removes the
        // borrow conflict the earlier review flag warned about).
        let now = Clock::get()?.unix_timestamp;
        let amount;
        let to;
        {
            let w = &ctx.accounts.wallet;
            require!(!w.paused, WErr::Paused);
            let p = &ctx.accounts.proposal;
            require!(!p.executed, WErr::AlreadyExecuted);
            require!(p.approvals.len() as u8 >= w.threshold, WErr::ThresholdNotMet);
            require!(now >= p.ready_at, WErr::TimelockNotElapsed);
            require!(ctx.accounts.destination.key() == p.to, WErr::DestinationNotAllowed);
            amount = p.amount;
            to = p.to;
        }

        // velocity check (G8) — mutate wallet, no other borrow held
        {
            let w = &mut ctx.accounts.wallet;
            if now >= w.window_start + SECONDS_PER_DAY {
                w.window_start = now;
                w.spent_in_window = 0;
            }
            let new_spent = w.spent_in_window.checked_add(amount).ok_or(WErr::Overflow)?;
            require!(w.daily_limit == 0 || new_spent <= w.daily_limit, WErr::VelocityExceeded);
            w.spent_in_window = new_spent;
        }

        // effects before interaction (G11)
        ctx.accounts.proposal.executed = true;

        // Move SOL from the dedicated vault PDA via a system-program CPI signed by
        // the vault's PDA seeds. The vault is a SystemAccount (system-program-owned),
        // so CPI transfer is the correct, borrow-safe way to move its lamports.
        let wallet_key = ctx.accounts.wallet.key();
        let vault_seeds: &[&[u8]] = &[b"vault", wallet_key.as_ref(), &[ctx.accounts.wallet.vault_bump]];
        let signer_seeds: &[&[&[u8]]] = &[vault_seeds];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
            },
            signer_seeds,
        );
        require!(ctx.accounts.destination.key() == to, WErr::DestinationNotAllowed);
        system_program::transfer(cpi, amount)?;
        Ok(())
    }
}

// helper: G1/G3 — only addresses in the owner set count; LF is never here.
fn is_owner(w: &Wallet, key: &Pubkey) -> bool {
    w.owners.iter().any(|o| o == key)
}

// ------------------------------- State ------------------------------------- //
#[account]
pub struct Wallet {
    pub owners: Vec<Pubkey>,
    pub threshold: u8,
    pub guardian: Pubkey,
    pub withdraw_delay: i64,
    pub large_amount: u64,
    pub allowlist_delay: i64,
    pub daily_limit: u64,
    pub paused: bool,
    pub window_start: i64,
    pub spent_in_window: u64,
    pub proposal_count: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
pub struct Proposal {
    pub wallet: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub executed: bool,
    pub approvals: Vec<Pubkey>,
    pub ready_at: i64,
}

#[account]
pub struct AllowEntry {
    pub dest: Pubkey,
    pub active_at: i64,
    pub pending: bool,
}

#[account]
pub struct UnpauseVote {
    pub voters: Vec<Pubkey>,
}

// ----------------------------- Contexts ------------------------------------ //
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + 4 + 32 * MAX_OWNERS + 1 + 32 + 8 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + 1 + 1,
        seeds = [b"wallet", payer.key().as_ref()], bump)]
    pub wallet: Account<'info, Wallet>,
    /// CHECK: SOL-holding vault PDA (system-program owned); created implicitly,
    /// receives deposits and is the source of withdrawals via signed CPI.
    #[account(seeds = [b"vault", wallet.key().as_ref()], bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub wallet: Account<'info, Wallet>,
    /// CHECK: vault PDA validated by seeds
    #[account(mut, seeds = [b"vault", wallet.key().as_ref()], bump = wallet.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOrGuardian<'info> {
    #[account(mut)]
    pub wallet: Account<'info, Wallet>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApproveUnpause<'info> {
    #[account(mut)]
    pub wallet: Account<'info, Wallet>,
    #[account(init_if_needed, payer = signer, space = 8 + 4 + 32 * MAX_OWNERS, seeds = [b"unpause", wallet.key().as_ref()], bump)]
    pub vote: Account<'info, UnpauseVote>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(dest: Pubkey)]
pub struct ProposeAllowlist<'info> {
    pub wallet: Account<'info, Wallet>,
    #[account(init, payer = signer, space = 8 + 32 + 8 + 1, seeds = [b"allow", wallet.key().as_ref(), dest.as_ref()], bump)]
    pub entry: Account<'info, AllowEntry>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MutateAllowlist<'info> {
    pub wallet: Account<'info, Wallet>,
    #[account(mut)]
    pub entry: Account<'info, AllowEntry>,
}

#[derive(Accounts)]
pub struct CancelAllowlist<'info> {
    pub wallet: Account<'info, Wallet>,
    #[account(mut)]
    pub entry: Account<'info, AllowEntry>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ProposeWithdraw<'info> {
    #[account(mut)]
    pub wallet: Account<'info, Wallet>,
    #[account(init, payer = signer, space = 8 + 32 + 32 + 8 + 1 + 4 + 32 * MAX_OWNERS + 8,
        seeds = [b"proposal", wallet.key().as_ref(), &wallet.proposal_count.to_le_bytes()], bump)]
    pub proposal: Account<'info, Proposal>,
    pub entry: Account<'info, AllowEntry>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    pub wallet: Account<'info, Wallet>,
    #[account(mut, has_one = wallet)]
    pub proposal: Account<'info, Proposal>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(mut)]
    pub wallet: Account<'info, Wallet>,
    /// CHECK: SOL-holding PDA, validated by seeds; system-program owned.
    #[account(mut, seeds = [b"vault", wallet.key().as_ref()], bump = wallet.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut, has_one = wallet)]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: validated against proposal.to in the handler
    #[account(mut)]
    pub destination: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// ------------------------------- Errors ------------------------------------ //
#[error_code]
pub enum WErr {
    #[msg("invalid owner set")] InvalidOwners,
    #[msg("invalid threshold")] InvalidThreshold,
    #[msg("zero address")] ZeroAddress,
    #[msg("duplicate owner")] DuplicateOwner,
    #[msg("not an owner")] NotOwner,
    #[msg("not owner or guardian")] NotOwnerOrGuardian,
    #[msg("already approved")] AlreadyApproved,
    #[msg("already executed")] AlreadyExecuted,
    #[msg("threshold not met")] ThresholdNotMet,
    #[msg("timelock not elapsed")] TimelockNotElapsed,
    #[msg("destination not allowlisted")] DestinationNotAllowed,
    #[msg("nothing pending")] NothingPending,
    #[msg("pending not ready")] PendingNotReady,
    #[msg("velocity exceeded")] VelocityExceeded,
    #[msg("paused")] Paused,
    #[msg("overflow")] Overflow,
}
