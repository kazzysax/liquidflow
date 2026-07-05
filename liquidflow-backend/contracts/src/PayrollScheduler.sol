// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PayrollScheduler
/// @notice Funded, cancellable, date-triggered payroll for the Integrate Payment
///         System (from integrate-payment-spec.md §9).
///
/// Model:
///   * The company OWNS this contract and funds it. It configures scheduled payouts
///     (recipient, amount, release time).
///   * Liquid Flow holds a "trigger" key whose ONLY power is to release a payout
///     ON OR AFTER its release time. The trigger key cannot change recipients or
///     amounts, cannot redirect funds, and cannot release early. Timing key, not a
///     money key. (Anyone may trigger after the time, in fact — the schedule itself
///     is the authorization; the trigger role just lets LF automate it.)
///   * The company can CANCEL or MODIFY any payout UNTIL it is released — the
///     "pull the plug" guarantee. Cancelling refunds nothing (funds stay in the
///     contract, company-controlled); the company can withdraw unallocated funds.
///   * Released funds go ONLY to the recipient the company set. No path lets anyone
///     send company funds to an arbitrary address.
///
/// Non-custodial: Liquid Flow can only advance time-gated, company-defined payouts.
contract PayrollScheduler {
    error NotCompany();
    error NotCompanyOrTrigger();
    error ZeroAddress();
    error UnknownPayout();
    error AlreadyReleased();
    error Cancelled();
    error NotDue();
    error InsufficientUnallocated();
    error TransferFailed();
    error Reentrancy();

    address public immutable company;   // owner; funds + configures
    address public immutable trigger;   // Liquid Flow; can only release on/after time

    struct Payout {
        address recipient;
        uint256 amount;
        uint64 releaseTime;
        bool released;
        bool cancelled;
    }

    uint256 public payoutCount;
    mapping(uint256 => Payout) public payouts;
    /// Sum of amounts for payouts that are scheduled but not yet released/cancelled.
    uint256 public allocated;

    uint256 private _lock = 1;
    modifier nonReentrant() { if (_lock != 1) revert Reentrancy(); _lock = 2; _; _lock = 1; }
    modifier onlyCompany() { if (msg.sender != company) revert NotCompany(); _; }

    event Funded(address indexed from, uint256 amount);
    event PayoutScheduled(uint256 indexed id, address indexed recipient, uint256 amount, uint64 releaseTime);
    event PayoutModified(uint256 indexed id, uint256 amount, uint64 releaseTime);
    event PayoutCancelled(uint256 indexed id);
    event PayoutReleased(uint256 indexed id, address indexed recipient, uint256 amount);
    event UnallocatedWithdrawn(address indexed to, uint256 amount);

    constructor(address company_, address trigger_) {
        if (company_ == address(0) || trigger_ == address(0)) revert ZeroAddress();
        company = company_;
        trigger = trigger_;
    }

    /// Fund the contract. Anyone can add funds; typically the company.
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// Funds available to schedule (balance not already promised to a payout).
    function unallocated() public view returns (uint256) {
        return address(this).balance - allocated;
    }

    // ----------------------- Company: configure ---------------------------- //
    function schedule(address recipient, uint256 amount, uint64 releaseTime)
        external onlyCompany returns (uint256 id)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount > unallocated()) revert InsufficientUnallocated();
        id = payoutCount++;
        payouts[id] = Payout(recipient, amount, releaseTime, false, false);
        allocated += amount;
        emit PayoutScheduled(id, recipient, amount, releaseTime);
    }

    /// Modify amount/time of a not-yet-released payout. Company only.
    function modify(uint256 id, uint256 newAmount, uint64 newReleaseTime) external onlyCompany {
        Payout storage p = payouts[id];
        if (p.recipient == address(0)) revert UnknownPayout();
        if (p.released) revert AlreadyReleased();
        if (p.cancelled) revert Cancelled();
        // adjust allocation
        uint256 freed = unallocated() + p.amount;
        if (newAmount > freed) revert InsufficientUnallocated();
        allocated = allocated - p.amount + newAmount;
        p.amount = newAmount;
        p.releaseTime = newReleaseTime;
        emit PayoutModified(id, newAmount, newReleaseTime);
    }

    /// Cancel a payout before release. Company only. Funds become unallocated again.
    function cancel(uint256 id) external onlyCompany {
        Payout storage p = payouts[id];
        if (p.recipient == address(0)) revert UnknownPayout();
        if (p.released) revert AlreadyReleased();
        if (p.cancelled) revert Cancelled();
        p.cancelled = true;
        allocated -= p.amount;
        emit PayoutCancelled(id);
    }

    /// Withdraw unallocated funds back to the company. Company only.
    function withdrawUnallocated(uint256 amount) external onlyCompany nonReentrant {
        if (amount > unallocated()) revert InsufficientUnallocated();
        (bool ok,) = payable(company).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit UnallocatedWithdrawn(company, amount);
    }

    // ------------------- Release (time-gated, no privilege) ---------------- //
    /// Release a due payout to its recipient. Callable by the company or the
    /// trigger (Liquid Flow) — but ONLY on/after releaseTime, and ONLY to the
    /// recipient the company set. The caller cannot change destination or amount.
    function release(uint256 id) external nonReentrant {
        if (msg.sender != company && msg.sender != trigger) revert NotCompanyOrTrigger();
        Payout storage p = payouts[id];
        if (p.recipient == address(0)) revert UnknownPayout();
        if (p.released) revert AlreadyReleased();
        if (p.cancelled) revert Cancelled();
        if (block.timestamp < p.releaseTime) revert NotDue();

        // effects before interaction
        p.released = true;
        allocated -= p.amount;

        (bool ok,) = payable(p.recipient).call{value: p.amount}("");
        if (!ok) revert TransferFailed();
        emit PayoutReleased(id, p.recipient, p.amount);
    }

    function getPayout(uint256 id)
        external view
        returns (address recipient, uint256 amount, uint64 releaseTime, bool released, bool cancelled)
    {
        Payout storage p = payouts[id];
        return (p.recipient, p.amount, p.releaseTime, p.released, p.cancelled);
    }
}
