// Liquid Flow — Platform Wallet (Aptos / Move)
//
// Non-custodial builder-owned account enforcing the shared guarantee set G1..G11.
// Liquid Flow is never an owner and can never move funds. Move's resource model
// gives a native guarantee EVM lacks: coins cannot be copied or silently dropped.
//
// VERIFICATION STATUS: review-grade. Build/test locally with the Aptos CLI
// (`aptos move test`) — the toolchain is network-blocked in the authoring sandbox.
//
// SECURITY NOTE (critical): the module's PACKAGE UPGRADE POLICY is the backdoor.
// Publish under an immutable or builder/guardian-multisig-controlled policy — never
// one where Liquid Flow can upgrade and replace this logic.

module liquidflow::platform_wallet {
    use std::signer;
    use std::vector;
    use aptos_framework::coin::{Self, Coin};
    use aptos_framework::aptos_coin::AptosCoin;
    use aptos_framework::timestamp;

    // ----------------------------- Errors ---------------------------------- //
    const E_INVALID_OWNERS: u64 = 1;
    const E_INVALID_THRESHOLD: u64 = 2;
    const E_NOT_OWNER: u64 = 3;
    const E_NOT_OWNER_OR_GUARDIAN: u64 = 4;
    const E_ALREADY_APPROVED: u64 = 5;
    const E_ALREADY_EXECUTED: u64 = 6;
    const E_THRESHOLD_NOT_MET: u64 = 7;
    const E_TIMELOCK: u64 = 8;
    const E_DEST_NOT_ALLOWED: u64 = 9;
    const E_NOTHING_PENDING: u64 = 10;
    const E_PENDING_NOT_READY: u64 = 11;
    const E_VELOCITY: u64 = 12;
    const E_PAUSED: u64 = 13;
    const E_DUP_OWNER: u64 = 14;

    const SECONDS_PER_DAY: u64 = 86_400;

    // ----------------------------- Storage --------------------------------- //
    struct AllowEntry has store, drop, copy {
        dest: address,
        active_at: u64,
        pending: bool,
    }

    struct Proposal has store {
        to: address,
        amount: u64,
        executed: bool,
        approvals: vector<address>,
        ready_at: u64,
    }

    /// The wallet resource lives under the builder's account. Holds the pooled
    /// AptosCoin as a resource — conservation enforced by the type system.
    struct Wallet has key {
        owners: vector<address>,
        threshold: u64,
        guardian: address,         // @0x0 disables
        withdraw_delay: u64,
        large_amount: u64,
        allowlist_delay: u64,
        daily_limit: u64,
        paused: bool,
        window_start: u64,
        spent_in_window: u64,
        allowlist: vector<AllowEntry>,
        proposals: vector<Proposal>,
        unpause_votes: vector<address>,
        funds: Coin<AptosCoin>,
    }

    // --------------------------- Initialize -------------------------------- //
    public entry fun initialize(
        builder: &signer,
        owners: vector<address>,
        threshold: u64,
        guardian: address,
        withdraw_delay: u64,
        large_amount: u64,
        allowlist_delay: u64,
        daily_limit: u64,
    ) {
        let n = vector::length(&owners);
        assert!(n > 0, E_INVALID_OWNERS);
        assert!(threshold >= 1 && threshold <= n, E_INVALID_THRESHOLD);
        // reject duplicates
        let i = 0;
        while (i < n) {
            let a = *vector::borrow(&owners, i);
            let j = i + 1;
            while (j < n) {
                assert!(a != *vector::borrow(&owners, j), E_DUP_OWNER);
                j = j + 1;
            };
            i = i + 1;
        };
        move_to(builder, Wallet {
            owners, threshold, guardian,
            withdraw_delay, large_amount, allowlist_delay, daily_limit,
            paused: false,
            window_start: timestamp::now_seconds(),
            spent_in_window: 0,
            allowlist: vector::empty<AllowEntry>(),
            proposals: vector::empty<Proposal>(),
            unpause_votes: vector::empty<address>(),
            funds: coin::zero<AptosCoin>(),
        });
    }

    /// Anyone may deposit AptosCoin into the wallet (settlement lands here).
    public entry fun deposit(payer: &signer, wallet_addr: address, amount: u64) acquires Wallet {
        let w = borrow_global_mut<Wallet>(wallet_addr);
        let c = coin::withdraw<AptosCoin>(payer, amount);
        coin::merge(&mut w.funds, c);
    }

    // -------------------------- Helpers (G1/G3) ---------------------------- //
    fun is_owner(w: &Wallet, a: address): bool {
        vector::contains(&w.owners, &a)
    }

    fun allow_index(w: &Wallet, dest: address): (bool, u64) {
        let i = 0; let n = vector::length(&w.allowlist);
        while (i < n) {
            if (vector::borrow(&w.allowlist, i).dest == dest) return (true, i);
            i = i + 1;
        };
        (false, 0)
    }

    fun is_allowed(w: &Wallet, dest: address): bool {
        let (found, idx) = allow_index(w, dest);
        if (!found) return false;
        let e = vector::borrow(&w.allowlist, idx);
        !e.pending && e.active_at != 0 && timestamp::now_seconds() >= e.active_at
    }

    // ------------------------ Circuit breaker (G9) ------------------------- //
    public entry fun pause(s: &signer, wallet_addr: address) acquires Wallet {
        let w = borrow_global_mut<Wallet>(wallet_addr);
        let a = signer::address_of(s);
        assert!(is_owner(w, a) || w.guardian == a, E_NOT_OWNER_OR_GUARDIAN);
        w.paused = true;
    }

    public entry fun approve_unpause(s: &signer, wallet_addr: address) acquires Wallet {
        let w = borrow_global_mut<Wallet>(wallet_addr);
        let a = signer::address_of(s);
        assert!(is_owner(w, a), E_NOT_OWNER);
        assert!(!vector::contains(&w.unpause_votes, &a), E_ALREADY_APPROVED);
        vector::push_back(&mut w.unpause_votes, a);
        if (vector::length(&w.unpause_votes) >= w.threshold) {
            w.paused = false;
            w.unpause_votes = vector::empty<address>();
        }
    }

    // ----------------------- Allowlist (G5, G6) ---------------------------- //
    public entry fun propose_allowlist(s: &signer, wallet_addr: address, dest: address) acquires Wallet {
        let w = borrow_global_mut<Wallet>(wallet_addr);
        assert!(is_owner(w, signer::address_of(s)), E_NOT_OWNER);
        let active_at = timestamp::now_seconds() + w.allowlist_delay;
        let (found, idx) = allow_index(w, dest);
        if (found) {
            let e = vector::borrow_mut(&mut w.allowlist, idx);
            e.active_at = active_at; e.pending = true;
        } else {
            vector::push_back(&mut w.allowlist, AllowEntry { dest, active_at, pending: true });
        }
    }

    public entry fun activate_allowlist(wallet_addr: address, dest: address) acquires Wallet {
        let w = borrow_global_mut<Wallet>(wallet_addr);
        let (found, idx) = allow_index(w, dest);
        assert!(found, E_NOTHING_PENDING);
        let e = vector::borrow_mut(&mut w.allowlist, idx);
        assert!(e.pending, E_NOTHING_PENDING);
        assert!(timestamp::now_seconds() >= e.active_at, E_PENDING_NOT_READY);
        e.pending = false;
    }

    public entry fun cancel_allowlist(s: &signer, wallet_addr: address, dest: address) acquires Wallet {
        let w = borrow_global_mut<Wallet>(wallet_addr);
        let a = signer::address_of(s);
        assert!(is_owner(w, a) || w.guardian == a, E_NOT_OWNER_OR_GUARDIAN);
        let (found, idx) = allow_index(w, dest);
        assert!(found, E_NOTHING_PENDING);
        let e = vector::borrow_mut(&mut w.allowlist, idx);
        assert!(e.pending, E_NOTHING_PENDING);
        e.pending = false; e.active_at = 0;
    }

    // -------------------- Propose / approve / execute ---------------------- //
    public entry fun propose_withdraw(s: &signer, wallet_addr: address, to: address, amount: u64) acquires Wallet {
        let w = borrow_global_mut<Wallet>(wallet_addr);
        assert!(!w.paused, E_PAUSED);
        let a = signer::address_of(s);
        assert!(is_owner(w, a), E_NOT_OWNER);
        assert!(is_allowed(w, to), E_DEST_NOT_ALLOWED);
        let now = timestamp::now_seconds();
        let ready_at = if (amount >= w.large_amount) now + w.withdraw_delay else now;
        let approvals = vector::empty<address>();
        vector::push_back(&mut approvals, a);
        vector::push_back(&mut w.proposals, Proposal { to, amount, executed: false, approvals, ready_at });
    }

    public entry fun approve(s: &signer, wallet_addr: address, id: u64) acquires Wallet {
        let w = borrow_global_mut<Wallet>(wallet_addr);
        assert!(!w.paused, E_PAUSED);
        let a = signer::address_of(s);
        assert!(is_owner(w, a), E_NOT_OWNER);
        let p = vector::borrow_mut(&mut w.proposals, id);
        assert!(!p.executed, E_ALREADY_EXECUTED);
        assert!(!vector::contains(&p.approvals, &a), E_ALREADY_APPROVED);
        vector::push_back(&mut p.approvals, a);
    }

    public entry fun execute(wallet_addr: address, id: u64) acquires Wallet {
        let now = timestamp::now_seconds();

        // PHASE 1 — all reads/checks via a single mutable ref, copying primitives out.
        // (Move's borrow checker is satisfied because we never hold a sub-borrow of
        //  w across a later &mut use; is_allowed is computed inline here.)
        let w = borrow_global_mut<Wallet>(wallet_addr);
        assert!(!w.paused, E_PAUSED);

        let to;
        let amount;
        {
            let p = vector::borrow(&w.proposals, id);
            assert!(!p.executed, E_ALREADY_EXECUTED);
            assert!(vector::length(&p.approvals) >= w.threshold, E_THRESHOLD_NOT_MET);
            assert!(now >= p.ready_at, E_TIMELOCK);
            to = p.to;
            amount = p.amount;
        };

        // allowlist check (G5) — inline to avoid a helper borrow overlapping &mut w
        {
            let (found, idx) = allow_index(w, to);
            assert!(found, E_DEST_NOT_ALLOWED);
            let e = vector::borrow(&w.allowlist, idx);
            assert!(!e.pending && e.active_at != 0 && now >= e.active_at, E_DEST_NOT_ALLOWED);
        };

        // PHASE 2 — mutations (velocity window + spent), then mark executed.
        if (now >= w.window_start + SECONDS_PER_DAY) {
            w.window_start = now;
            w.spent_in_window = 0;
        };
        let new_spent = w.spent_in_window + amount;
        assert!(w.daily_limit == 0 || new_spent <= w.daily_limit, E_VELOCITY);
        w.spent_in_window = new_spent;

        let p = vector::borrow_mut(&mut w.proposals, id);
        p.executed = true; // effects before interaction (G11)

        // PHASE 3 — move the resource out. Move's type system guarantees the coin
        // is conserved (cannot be copied or dropped).
        let out = coin::extract(&mut w.funds, amount);
        coin::deposit<AptosCoin>(to, out);
    }

    #[view]
    public fun owner_count(wallet_addr: address): u64 acquires Wallet {
        vector::length(&borrow_global<Wallet>(wallet_addr).owners)
    }
}
