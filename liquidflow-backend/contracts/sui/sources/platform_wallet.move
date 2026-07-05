// Liquid Flow — Platform Wallet (Sui / Move, object model)
//
// Non-custodial builder-owned wallet enforcing the shared guarantee set G1..G11.
// Liquid Flow is never an owner and can never move funds. On Sui the wallet is a
// SHARED OBJECT so the N owners can all interact with it; balances are held as a
// Balance<SUI> inside that object.
//
// VERIFICATION STATUS: review-grade. Build/test locally with the Sui CLI
// (`sui move test`) — the toolchain is network-blocked in the authoring sandbox.
//
// SECURITY NOTE (critical): the package UPGRADE CAP is the backdoor. Burn it or
// hold it under a builder/guardian multisig — never let Liquid Flow upgrade and
// replace this logic.

module liquidflow::platform_wallet {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use std::vector;

    // ------------------------------ Errors --------------------------------- //
    const E_INVALID_THRESHOLD: u64 = 1;
    const E_NOT_OWNER: u64 = 2;
    const E_NOT_OWNER_OR_GUARDIAN: u64 = 3;
    const E_ALREADY_APPROVED: u64 = 4;
    const E_ALREADY_EXECUTED: u64 = 5;
    const E_THRESHOLD_NOT_MET: u64 = 6;
    const E_TIMELOCK: u64 = 7;
    const E_DEST_NOT_ALLOWED: u64 = 8;
    const E_NOTHING_PENDING: u64 = 9;
    const E_PENDING_NOT_READY: u64 = 10;
    const E_VELOCITY: u64 = 11;
    const E_PAUSED: u64 = 12;
    const E_DUP_OWNER: u64 = 13;

    const MS_PER_DAY: u64 = 86_400_000; // Sui clock is in milliseconds

    // --------------------------- Sub-structures ---------------------------- //
    public struct AllowEntry has store, drop {
        dest: address,
        active_at: u64,
        pending: bool,
    }

    public struct Proposal has store {
        to: address,
        amount: u64,
        executed: bool,
        approvals: vector<address>,
        ready_at: u64,
    }

    /// The shared wallet object.
    public struct Wallet has key {
        id: UID,
        owners: vector<address>,
        threshold: u64,
        guardian: address,           // @0x0 disables
        withdraw_delay: u64,         // ms
        large_amount: u64,
        allowlist_delay: u64,        // ms
        daily_limit: u64,
        paused: bool,
        window_start: u64,           // ms
        spent_in_window: u64,
        allowlist: vector<AllowEntry>,
        proposals: vector<Proposal>,
        unpause_votes: vector<address>,
        funds: Balance<SUI>,
    }

    // ---------------------------- Initialize ------------------------------- //
    public entry fun initialize(
        owners: vector<address>,
        threshold: u64,
        guardian: address,
        withdraw_delay: u64,
        large_amount: u64,
        allowlist_delay: u64,
        daily_limit: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let n = vector::length(&owners);
        assert!(threshold >= 1 && threshold <= n, E_INVALID_THRESHOLD);
        let i = 0;
        while (i < n) {
            let a = *vector::borrow(&owners, i);
            let j = i + 1;
            while (j < n) { assert!(a != *vector::borrow(&owners, j), E_DUP_OWNER); j = j + 1; };
            i = i + 1;
        };
        let w = Wallet {
            id: object::new(ctx),
            owners, threshold, guardian,
            withdraw_delay, large_amount, allowlist_delay, daily_limit,
            paused: false,
            window_start: clock::timestamp_ms(clock),
            spent_in_window: 0,
            allowlist: vector::empty<AllowEntry>(),
            proposals: vector::empty<Proposal>(),
            unpause_votes: vector::empty<address>(),
            funds: balance::zero<SUI>(),
        };
        // shared so all owners can interact (G2)
        transfer::share_object(w);
    }

    /// Deposit SUI into the wallet (settlement lands here).
    public entry fun deposit(w: &mut Wallet, c: Coin<SUI>) {
        balance::join(&mut w.funds, coin::into_balance(c));
    }

    // --------------------------- Helpers ----------------------------------- //
    fun is_owner(w: &Wallet, a: address): bool { vector::contains(&w.owners, &a) }

    fun allow_index(w: &Wallet, dest: address): (bool, u64) {
        let i = 0; let n = vector::length(&w.allowlist);
        while (i < n) { if (vector::borrow(&w.allowlist, i).dest == dest) return (true, i); i = i + 1; };
        (false, 0)
    }

    fun is_allowed(w: &Wallet, dest: address, now: u64): bool {
        let (found, idx) = allow_index(w, dest);
        if (!found) return false;
        let e = vector::borrow(&w.allowlist, idx);
        !e.pending && e.active_at != 0 && now >= e.active_at
    }

    // ------------------------ Circuit breaker (G9) ------------------------- //
    public entry fun pause(w: &mut Wallet, ctx: &TxContext) {
        let a = tx_context::sender(ctx);
        assert!(is_owner(w, a) || w.guardian == a, E_NOT_OWNER_OR_GUARDIAN);
        w.paused = true;
    }

    public entry fun approve_unpause(w: &mut Wallet, ctx: &TxContext) {
        let a = tx_context::sender(ctx);
        assert!(is_owner(w, a), E_NOT_OWNER);
        assert!(!vector::contains(&w.unpause_votes, &a), E_ALREADY_APPROVED);
        vector::push_back(&mut w.unpause_votes, a);
        if (vector::length(&w.unpause_votes) >= w.threshold) {
            w.paused = false;
            w.unpause_votes = vector::empty<address>();
        }
    }

    // ----------------------- Allowlist (G5, G6) ---------------------------- //
    public entry fun propose_allowlist(w: &mut Wallet, dest: address, clock: &Clock, ctx: &TxContext) {
        assert!(is_owner(w, tx_context::sender(ctx)), E_NOT_OWNER);
        let active_at = clock::timestamp_ms(clock) + w.allowlist_delay;
        let (found, idx) = allow_index(w, dest);
        if (found) {
            let e = vector::borrow_mut(&mut w.allowlist, idx);
            e.active_at = active_at; e.pending = true;
        } else {
            vector::push_back(&mut w.allowlist, AllowEntry { dest, active_at, pending: true });
        }
    }

    public entry fun activate_allowlist(w: &mut Wallet, dest: address, clock: &Clock) {
        let (found, idx) = allow_index(w, dest);
        assert!(found, E_NOTHING_PENDING);
        let e = vector::borrow_mut(&mut w.allowlist, idx);
        assert!(e.pending, E_NOTHING_PENDING);
        assert!(clock::timestamp_ms(clock) >= e.active_at, E_PENDING_NOT_READY);
        e.pending = false;
    }

    public entry fun cancel_allowlist(w: &mut Wallet, dest: address, ctx: &TxContext) {
        let a = tx_context::sender(ctx);
        assert!(is_owner(w, a) || w.guardian == a, E_NOT_OWNER_OR_GUARDIAN);
        let (found, idx) = allow_index(w, dest);
        assert!(found, E_NOTHING_PENDING);
        let e = vector::borrow_mut(&mut w.allowlist, idx);
        assert!(e.pending, E_NOTHING_PENDING);
        e.pending = false; e.active_at = 0;
    }

    // -------------------- Propose / approve / execute ---------------------- //
    public entry fun propose_withdraw(w: &mut Wallet, to: address, amount: u64, clock: &Clock, ctx: &TxContext) {
        assert!(!w.paused, E_PAUSED);
        let a = tx_context::sender(ctx);
        assert!(is_owner(w, a), E_NOT_OWNER);
        let now = clock::timestamp_ms(clock);
        assert!(is_allowed(w, to, now), E_DEST_NOT_ALLOWED);
        let ready_at = if (amount >= w.large_amount) now + w.withdraw_delay else now;
        let approvals = vector::empty<address>();
        vector::push_back(&mut approvals, a);
        vector::push_back(&mut w.proposals, Proposal { to, amount, executed: false, approvals, ready_at });
    }

    public entry fun approve(w: &mut Wallet, id: u64, ctx: &TxContext) {
        assert!(!w.paused, E_PAUSED);
        let a = tx_context::sender(ctx);
        assert!(is_owner(w, a), E_NOT_OWNER);
        let p = vector::borrow_mut(&mut w.proposals, id);
        assert!(!p.executed, E_ALREADY_EXECUTED);
        assert!(!vector::contains(&p.approvals, &a), E_ALREADY_APPROVED);
        vector::push_back(&mut p.approvals, a);
    }

    public entry fun execute(w: &mut Wallet, id: u64, clock: &Clock, ctx: &mut TxContext) {
        assert!(!w.paused, E_PAUSED);
        let now = clock::timestamp_ms(clock);

        let (to, amount);
        {
            let p = vector::borrow(&w.proposals, id);
            assert!(!p.executed, E_ALREADY_EXECUTED);
            assert!(vector::length(&p.approvals) >= w.threshold, E_THRESHOLD_NOT_MET);
            assert!(now >= p.ready_at, E_TIMELOCK);
            to = p.to; amount = p.amount;
        };
        assert!(is_allowed(w, to, now), E_DEST_NOT_ALLOWED);

        if (now >= w.window_start + MS_PER_DAY) { w.window_start = now; w.spent_in_window = 0; };
        let new_spent = w.spent_in_window + amount;
        assert!(w.daily_limit == 0 || new_spent <= w.daily_limit, E_VELOCITY);
        w.spent_in_window = new_spent;

        let p = vector::borrow_mut(&mut w.proposals, id);
        p.executed = true;

        // split the balance and transfer a Coin to the destination
        let out = coin::from_balance(balance::split(&mut w.funds, amount), ctx);
        transfer::public_transfer(out, to);
    }

    public fun owner_count(w: &Wallet): u64 { vector::length(&w.owners) }
}
