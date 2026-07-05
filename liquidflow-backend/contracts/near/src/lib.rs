// Liquid Flow — Platform Wallet (NEAR / near-sdk, Rust -> WASM)
//
// Non-custodial builder-owned contract enforcing the shared guarantee set G1..G11.
// Liquid Flow is never an owner and can never move funds. All controls on-chain.
//
// VERIFICATION STATUS: review-grade. Build/test locally with cargo + near
// workspaces (`cargo test`, `cargo near build`) — the toolchain is network-blocked
// in the authoring sandbox.
//
// SECURITY NOTE (critical): the contract account's FULL-ACCESS KEYS can redeploy or
// delete this contract. After deploy, remove them (lock the account) or place them
// under a builder/guardian multisig — never Liquid Flow. NEAR token transfers are
// async (Promises); native NEAR transfers here use Promise::transfer, which cannot
// fail-and-silently-desync the way cross-contract calls can, so we mark executed
// before transfer and rely on transfer atomicity for native NEAR.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::{
    env, near_bindgen, AccountId, NearToken, PanicOnDefault, Promise, BorshStorageKey,
};
use near_sdk::store::{Vector, LookupMap};

pub type Timestamp = u64; // nanoseconds (env::block_timestamp)
const NS_PER_DAY: u64 = 86_400 * 1_000_000_000;

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Owners,
    Proposals,
    Allowlist,
    UnpauseVotes,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct AllowEntry {
    pub active_at: Timestamp,
    pub pending: bool,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct Proposal {
    pub to: AccountId,
    pub amount: u128,      // yoctoNEAR
    pub executed: bool,
    pub approvals: Vec<AccountId>,
    pub ready_at: Timestamp,
}

#[near_bindgen]
#[derive(BorshSerialize, BorshDeserialize, PanicOnDefault)]
pub struct PlatformWallet {
    owners: Vector<AccountId>,
    threshold: u32,
    guardian: Option<AccountId>,
    withdraw_delay: u64,       // ns
    large_amount: u128,
    allowlist_delay: u64,      // ns
    daily_limit: u128,         // 0 disables
    paused: bool,
    window_start: Timestamp,
    spent_in_window: u128,
    allowlist: LookupMap<AccountId, AllowEntry>,
    proposals: Vector<Proposal>,
    unpause_votes: Vector<AccountId>,
}

#[near_bindgen]
impl PlatformWallet {
    #[init]
    pub fn new(
        owners: Vec<AccountId>,
        threshold: u32,
        guardian: Option<AccountId>,
        withdraw_delay: u64,
        large_amount: u128,
        allowlist_delay: u64,
        daily_limit: u128,
    ) -> Self {
        assert!(!owners.is_empty(), "invalid owners");
        assert!(threshold >= 1 && threshold as usize <= owners.len(), "invalid threshold");
        // reject duplicates
        for i in 0..owners.len() {
            for j in (i + 1)..owners.len() {
                assert!(owners[i] != owners[j], "duplicate owner");
            }
        }
        let mut o = Vector::new(StorageKey::Owners);
        for a in owners { o.push(a); }
        Self {
            owners: o,
            threshold,
            guardian,
            withdraw_delay,
            large_amount,
            allowlist_delay,
            daily_limit,
            paused: false,
            window_start: env::block_timestamp(),
            spent_in_window: 0,
            allowlist: LookupMap::new(StorageKey::Allowlist),
            proposals: Vector::new(StorageKey::Proposals),
            unpause_votes: Vector::new(StorageKey::UnpauseVotes),
        }
    }

    // Native NEAR deposits arrive by simply sending to the contract account; the
    // balance is held by the account. (NEP-141 tokens would use ft_on_transfer.)

    // ----------------------------- Helpers (G1/G3) ---------------------------
    fn is_owner(&self, a: &AccountId) -> bool {
        self.owners.iter().any(|o| o == a)
    }
    fn is_guardian(&self, a: &AccountId) -> bool {
        self.guardian.as_ref().map_or(false, |g| g == a)
    }
    fn is_allowed(&self, dest: &AccountId) -> bool {
        match self.allowlist.get(dest) {
            Some(e) => !e.pending && e.active_at != 0 && env::block_timestamp() >= e.active_at,
            None => false,
        }
    }

    // ------------------------- Circuit breaker (G9) --------------------------
    pub fn pause(&mut self) {
        let s = env::predecessor_account_id();
        assert!(self.is_owner(&s) || self.is_guardian(&s), "not owner or guardian");
        self.paused = true;
    }

    pub fn approve_unpause(&mut self) {
        let s = env::predecessor_account_id();
        assert!(self.is_owner(&s), "not owner");
        assert!(!self.unpause_votes.iter().any(|v| v == &s), "already approved");
        self.unpause_votes.push(s);
        if self.unpause_votes.len() as u32 >= self.threshold {
            self.paused = false;
            self.unpause_votes.clear();
        }
    }

    // --------------------------- Allowlist (G5,G6) ---------------------------
    pub fn propose_allowlist(&mut self, dest: AccountId) {
        let s = env::predecessor_account_id();
        assert!(self.is_owner(&s), "not owner");
        let active_at = env::block_timestamp() + self.allowlist_delay;
        self.allowlist.insert(dest, AllowEntry { active_at, pending: true });
    }

    pub fn activate_allowlist(&mut self, dest: AccountId) {
        let e = self.allowlist.get(&dest).cloned().expect("nothing pending");
        assert!(e.pending, "nothing pending");
        assert!(env::block_timestamp() >= e.active_at, "pending not ready");
        self.allowlist.insert(dest, AllowEntry { active_at: e.active_at, pending: false });
    }

    pub fn cancel_allowlist(&mut self, dest: AccountId) {
        let s = env::predecessor_account_id();
        assert!(self.is_owner(&s) || self.is_guardian(&s), "not owner or guardian");
        let e = self.allowlist.get(&dest).cloned().expect("nothing pending");
        assert!(e.pending, "nothing pending");
        self.allowlist.remove(&dest);
    }

    // --------------------- Propose / approve / execute -----------------------
    pub fn propose_withdraw(&mut self, to: AccountId, amount: u128) {
        assert!(!self.paused, "paused");
        let s = env::predecessor_account_id();
        assert!(self.is_owner(&s), "not owner");
        assert!(self.is_allowed(&to), "destination not allowlisted");
        let now = env::block_timestamp();
        let ready_at = if amount >= self.large_amount { now + self.withdraw_delay } else { now };
        self.proposals.push(Proposal { to, amount, executed: false, approvals: vec![s], ready_at });
    }

    pub fn approve(&mut self, id: u32) {
        assert!(!self.paused, "paused");
        let s = env::predecessor_account_id();
        assert!(self.is_owner(&s), "not owner");
        let p = self.proposals.get_mut(id).expect("unknown proposal");
        assert!(!p.executed, "already executed");
        assert!(!p.approvals.iter().any(|a| a == &s), "already approved");
        p.approvals.push(s);
    }

    pub fn execute(&mut self, id: u32) -> Promise {
        assert!(!self.paused, "paused");
        let now = env::block_timestamp();

        let (to, amount) = {
            let p = self.proposals.get(id).expect("unknown proposal");
            assert!(!p.executed, "already executed");
            assert!(p.approvals.len() as u32 >= self.threshold, "threshold not met");
            assert!(now >= p.ready_at, "timelock not elapsed");
            (p.to.clone(), p.amount)
        };
        assert!(self.is_allowed(&to), "destination not allowlisted");

        // velocity (G8)
        if now >= self.window_start + NS_PER_DAY {
            self.window_start = now;
            self.spent_in_window = 0;
        }
        let new_spent = self.spent_in_window.checked_add(amount).expect("overflow");
        assert!(self.daily_limit == 0 || new_spent <= self.daily_limit, "velocity exceeded");
        self.spent_in_window = new_spent;

        // effects before interaction (G11)
        let p = self.proposals.get_mut(id).expect("unknown proposal");
        p.executed = true;

        // native NEAR transfer (atomic for the transfer action itself)
        Promise::new(to).transfer(NearToken::from_yoctonear(amount))
    }

    // ------------------------------- Views -----------------------------------
    pub fn owner_count(&self) -> u32 { self.owners.len() }
    pub fn is_paused(&self) -> bool { self.paused }
}
