// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PayrollSchedulerERC20
/// @notice Non-custodial, date-triggered payroll that pays an ERC-20 token (e.g. USDC).
///         Same model as PayrollScheduler, but funded with tokens instead of native coin,
///         plus releaseBatch() so a whole pay cycle settles in one transaction.
///
///   * The company OWNS this contract and funds it by transferring `token` to it.
///   * Liquid Flow holds a "trigger" key that can ONLY release a payout on/after its
///     release time, ONLY to the recipient the company set. Timing key, not a money key.
///   * The company can modify/cancel any payout until release, and withdraw unallocated
///     funds at any time. Released funds go ONLY to the recipient the company chose.
///
/// Non-custodial: Liquid Flow can only advance time-gated, company-defined payouts.
/// ⚠️ UNAUDITED — testnet only. Must pass a dedicated contract audit before mainnet.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract PayrollSchedulerERC20 {
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

    address public immutable company;
    address public immutable trigger;
    IERC20  public immutable token;

    struct Payout {
        address recipient;
        uint256 amount;
        uint64  releaseTime;
        bool    released;
        bool    cancelled;
    }

    uint256 public payoutCount;
    mapping(uint256 => Payout) public payouts;
    uint256 public allocated;

    uint256 private _lock = 1;
    modifier nonReentrant() { if (_lock != 1) revert Reentrancy(); _lock = 2; _; _lock = 1; }
    modifier onlyCompany() { if (msg.sender != company) revert NotCompany(); _; }

    event PayoutScheduled(uint256 indexed id, address indexed recipient, uint256 amount, uint64 releaseTime);
    event PayoutModified(uint256 indexed id, uint256 amount, uint64 releaseTime);
    event PayoutCancelled(uint256 indexed id);
    event PayoutReleased(uint256 indexed id, address indexed recipient, uint256 amount);
    event UnallocatedWithdrawn(address indexed to, uint256 amount);

    constructor(address company_, address trigger_, address token_) {
        if (company_ == address(0) || trigger_ == address(0) || token_ == address(0)) revert ZeroAddress();
        company = company_;
        trigger = trigger_;
        token   = IERC20(token_);
    }

    /// Current token balance held by this contract. Fund by transferring `token` here.
    function balance() public view returns (uint256) { return token.balanceOf(address(this)); }
    /// Funds not yet promised to a scheduled payout.
    function unallocated() public view returns (uint256) { return balance() - allocated; }

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

    function modify(uint256 id, uint256 newAmount, uint64 newReleaseTime) external onlyCompany {
        Payout storage p = payouts[id];
        if (p.recipient == address(0)) revert UnknownPayout();
        if (p.released) revert AlreadyReleased();
        if (p.cancelled) revert Cancelled();
        uint256 freed = unallocated() + p.amount;
        if (newAmount > freed) revert InsufficientUnallocated();
        allocated = allocated - p.amount + newAmount;
        p.amount = newAmount;
        p.releaseTime = newReleaseTime;
        emit PayoutModified(id, newAmount, newReleaseTime);
    }

    function cancel(uint256 id) external onlyCompany {
        Payout storage p = payouts[id];
        if (p.recipient == address(0)) revert UnknownPayout();
        if (p.released) revert AlreadyReleased();
        if (p.cancelled) revert Cancelled();
        p.cancelled = true;
        allocated -= p.amount;
        emit PayoutCancelled(id);
    }

    function withdrawUnallocated(uint256 amount) external onlyCompany nonReentrant {
        if (amount > unallocated()) revert InsufficientUnallocated();
        _safeTransfer(company, amount);
        emit UnallocatedWithdrawn(company, amount);
    }

    // ------------------- Release (time-gated, no privilege) ---------------- //
    function release(uint256 id) public nonReentrant {
        if (msg.sender != company && msg.sender != trigger) revert NotCompanyOrTrigger();
        _release(id);
    }

    /// Release many due payouts in one transaction (the whole pay cycle).
    function releaseBatch(uint256[] calldata ids) external nonReentrant {
        if (msg.sender != company && msg.sender != trigger) revert NotCompanyOrTrigger();
        for (uint256 i = 0; i < ids.length; i++) {
            _release(ids[i]);
        }
    }

    function _release(uint256 id) internal {
        Payout storage p = payouts[id];
        if (p.recipient == address(0)) revert UnknownPayout();
        if (p.released) revert AlreadyReleased();
        if (p.cancelled) revert Cancelled();
        if (block.timestamp < p.releaseTime) revert NotDue();
        p.released = true;
        allocated -= p.amount;
        _safeTransfer(p.recipient, p.amount);
        emit PayoutReleased(id, p.recipient, p.amount);
    }

    /// Handles non-standard ERC-20s (USDC returns true; some return no data).
    function _safeTransfer(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function getPayout(uint256 id)
        external view
        returns (address recipient, uint256 amount, uint64 releaseTime, bool released, bool cancelled)
    {
        Payout storage p = payouts[id];
        return (p.recipient, p.amount, p.releaseTime, p.released, p.cancelled);
    }
}
