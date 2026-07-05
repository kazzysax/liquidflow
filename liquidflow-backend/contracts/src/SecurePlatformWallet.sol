// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SecurePlatformWallet
/// @notice Builder-owned smart account with defense-in-depth fund protection.
///         Extends the base quorum model with on-chain security controls that
///         make funds genuinely hard to drain even if owner keys are compromised.
///
/// Non-custodial: Liquid Flow is never an owner and can never move funds. Every
/// protection here is enforced by the contract, not by any off-chain server.
///
/// Security controls (all enforced on-chain):
///   1. Quorum: N-owner set, configurable threshold (e.g. 2-of-N) to move funds.
///   2. Allowlist with time-delay: funds can only be sent to allowlisted
///      destinations. Adding a new destination is subject to a delay, during
///      which the owners (or a guardian) can cancel it. A thief with keys cannot
///      instantly send to a fresh address.
///   3. Time-lock on large withdrawals: any withdrawal at/above `largeAmount`
///      must wait `withdrawDelay` after final approval before it can execute,
///      giving time to detect and cancel a fraudulent transfer.
///   4. Velocity limit: a rolling 24h cap on total value leaving the wallet.
///   5. Circuit breaker: owners or a guardian can pause all withdrawals instantly;
///      unpausing is itself quorum-gated.
///
/// Sweep-to-own-wallet remains available so the builder is never locked in, but
/// the sweep destination must be an allowlisted address (added via the same
/// delay), so a key thief cannot sweep to themselves.
contract SecurePlatformWallet {
    // ----------------------------- Errors ------------------------------- //
    error NotOwner();
    error NotOwnerOrGuardian();
    error AlreadyOwner();
    error ZeroAddress();
    error InvalidThreshold();
    error UnknownProposal();
    error AlreadyApproved();
    error AlreadyExecuted();
    error ThresholdNotMet();
    error TransferFailed();
    error Reentrancy();
    error DestinationNotAllowed();
    error TimelockNotElapsed();
    error VelocityExceeded();
    error NothingToChange();
    error Paused();
    error NotPaused();
    error PendingNotReady();
    error NothingPending();

    // --------------------------- Ownership ------------------------------ //
    mapping(address => bool) public isOwner;
    address[] public owners;
    uint256 public threshold;

    /// Optional guardian: can pause and can cancel pending allowlist additions,
    /// but can NEVER move funds or approve withdrawals. A safety role, not a money role.
    address public guardian;

    // ----------------------- Security parameters ------------------------ //
    uint256 public withdrawDelay;   // seconds a large withdrawal must wait
    uint256 public largeAmount;     // threshold (wei/base units) considered "large"
    uint256 public allowlistDelay;  // seconds before a new destination is active
    uint256 public dailyLimit;      // max total value out per rolling 24h
    bool public paused;

    // Rolling velocity window (native coin)
    uint256 public windowStart;     // start timestamp of the current 24h window
    uint256 public spentInWindow;   // value moved out within the window

    // Per-token rolling velocity (F1 fix): token => its own 24h window + spend.
    // tokenDailyLimit[token] == 0 means "no limit configured" for that token.
    mapping(address => uint256) public tokenDailyLimit;
    mapping(address => uint256) public tokenWindowStart;
    mapping(address => uint256) public tokenSpentInWindow;

    // Allowlist: destination => activation timestamp (0 = not allowed)
    mapping(address => uint256) public allowedAt;     // when it becomes active
    mapping(address => bool) public allowPending;     // proposed but not yet active

    // --------------------------- Proposals ------------------------------ //
    enum Action { WithdrawNative, WithdrawToken, SweepNative, SweepToken }

    struct Proposal {
        Action action;
        address to;
        address token;
        uint256 amount;
        bool executed;
        uint256 approvals;
        uint256 readyAt;   // earliest execution time (set when quorum reached)
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public approved;

    // -------------------------- Reentrancy ------------------------------ //
    uint256 private _lock = 1;
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }
    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }
    modifier onlyOwnerOrGuardian() {
        if (!isOwner[msg.sender] && msg.sender != guardian) revert NotOwnerOrGuardian();
        _;
    }
    modifier notPaused() {
        if (paused) revert Paused();
        _;
    }

    // ----------------------------- Events ------------------------------- //
    event Deposit(address indexed from, uint256 amount);
    event ProposalCreated(uint256 indexed id, Action action, address indexed to, address token, uint256 amount);
    event Approved(uint256 indexed id, address indexed owner, uint256 approvals);
    event QuorumReached(uint256 indexed id, uint256 readyAt);
    event Executed(uint256 indexed id);
    event AllowlistProposed(address indexed dest, uint256 activeAt);
    event AllowlistActivated(address indexed dest);
    event AllowlistCancelled(address indexed dest);
    event PausedSet(bool paused, address indexed by);
    event GuardianSet(address indexed guardian);

    // -------------------------- Construction ---------------------------- //
    constructor(
        address[] memory initialOwners,
        uint256 initialThreshold,
        address guardian_,
        uint256 withdrawDelay_,
        uint256 largeAmount_,
        uint256 allowlistDelay_,
        uint256 dailyLimit_
    ) {
        uint256 n = initialOwners.length;
        if (initialThreshold == 0 || initialThreshold > n) revert InvalidThreshold();
        for (uint256 i = 0; i < n; i++) {
            address o = initialOwners[i];
            if (o == address(0)) revert ZeroAddress();
            if (isOwner[o]) revert AlreadyOwner();
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = initialThreshold;
        guardian = guardian_;            // may be address(0) to disable
        withdrawDelay = withdrawDelay_;
        largeAmount = largeAmount_;
        allowlistDelay = allowlistDelay_;
        dailyLimit = dailyLimit_;
        windowStart = block.timestamp;
        emit GuardianSet(guardian_);
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    // ------------------------ Circuit breaker --------------------------- //
    /// Pause is fast and broad: any owner OR the guardian can stop withdrawals.
    /// A fresh pause (unpaused -> paused) advances the pause epoch, so any unpause
    /// votes from a previous cycle are abandoned and cannot lower the quorum bar.
    function pause() external onlyOwnerOrGuardian {
        if (!paused) {
            pauseEpoch += 1;
        }
        paused = true;
        emit PausedSet(true, msg.sender);
    }

    /// Unpause requires quorum to prevent a single compromised key from
    /// un-pausing. Votes are scoped to a pause "epoch": each pause() increments the
    /// epoch, so votes from a previous pause cycle never carry over (fixes a stale-
    /// vote flaw where leftover approvals could lower the bar on a later pause).
    uint256 public pauseEpoch;
    mapping(uint256 => mapping(address => bool)) public unpauseApprovedIn;
    mapping(uint256 => uint256) public unpauseApprovalsIn;
    function approveUnpause() external onlyOwner {
        if (!paused) revert NotPaused();
        uint256 epoch = pauseEpoch;
        if (!unpauseApprovedIn[epoch][msg.sender]) {
            unpauseApprovedIn[epoch][msg.sender] = true;
            unpauseApprovalsIn[epoch] += 1;
        }
        if (unpauseApprovalsIn[epoch] >= threshold) {
            paused = false;
            // No loop needed: advancing the epoch on the next pause abandons this
            // epoch's votes entirely.
            emit PausedSet(false, msg.sender);
        }
    }

    // --------------------- Allowlist (with delay) ----------------------- //
    function proposeAllowlist(address dest) external onlyOwner {
        if (dest == address(0)) revert ZeroAddress();
        allowPending[dest] = true;
        uint256 activeAt = block.timestamp + allowlistDelay;
        allowedAt[dest] = activeAt;
        emit AllowlistProposed(dest, activeAt);
    }

    /// Anyone may finalize once the delay has elapsed (no privilege; time is the gate).
    function activateAllowlist(address dest) external {
        uint256 t = allowedAt[dest];
        if (t == 0 || !allowPending[dest]) revert NothingPending();
        if (block.timestamp < t) revert PendingNotReady();
        allowPending[dest] = false; // now fully active; allowedAt stays as activation marker
        emit AllowlistActivated(dest);
    }

    /// Owners or guardian can cancel a pending (not-yet-active) allowlist addition —
    /// the anti-theft escape hatch during the delay window.
    function cancelAllowlist(address dest) external onlyOwnerOrGuardian {
        if (!allowPending[dest]) revert NothingPending();
        allowPending[dest] = false;
        allowedAt[dest] = 0;
        emit AllowlistCancelled(dest);
    }

    /// Revoke an ALREADY-ACTIVE destination. Removing a destination only tightens
    /// security (a compromised or retired payout address can no longer receive
    /// funds), so like a circuit-breaker pause it is allowed unilaterally by any
    /// owner or the guardian — no quorum needed. Re-adding still goes through the
    /// full delayed propose/activate path.
    function revokeAllowlist(address dest) external onlyOwnerOrGuardian {
        if (allowedAt[dest] == 0) revert NothingPending();
        allowPending[dest] = false;
        allowedAt[dest] = 0;
        emit AllowlistCancelled(dest);
    }

    function isAllowed(address dest) public view returns (bool) {
        uint256 t = allowedAt[dest];
        return t != 0 && !allowPending[dest] && block.timestamp >= t;
    }

    // --------------------------- Proposals ------------------------------ //
    function proposeWithdrawNative(address to, uint256 amount) external onlyOwner notPaused returns (uint256) {
        if (!isAllowed(to)) revert DestinationNotAllowed();
        return _create(Action.WithdrawNative, to, address(0), amount);
    }
    function proposeWithdrawToken(address token, address to, uint256 amount) external onlyOwner notPaused returns (uint256) {
        if (token == address(0)) revert ZeroAddress();
        if (!isAllowed(to)) revert DestinationNotAllowed();
        return _create(Action.WithdrawToken, to, token, amount);
    }
    function proposeSweepNative(address to) external onlyOwner notPaused returns (uint256) {
        if (!isAllowed(to)) revert DestinationNotAllowed();
        return _create(Action.SweepNative, to, address(0), 0);
    }
    function proposeSweepToken(address token, address to) external onlyOwner notPaused returns (uint256) {
        if (token == address(0)) revert ZeroAddress();
        if (!isAllowed(to)) revert DestinationNotAllowed();
        return _create(Action.SweepToken, to, token, 0);
    }

    function _create(Action action, address to, address token, uint256 amount) internal returns (uint256 id) {
        id = proposalCount++;
        Proposal storage p = proposals[id];
        p.action = action;
        p.to = to;
        p.token = token;
        p.amount = amount;
        emit ProposalCreated(id, action, to, token, amount);
        _approve(id);
    }

    function approve(uint256 id) external onlyOwner notPaused {
        _approve(id);
    }

    function _approve(uint256 id) internal {
        Proposal storage p = proposals[id];
        if (p.to == address(0)) revert UnknownProposal();
        if (p.executed) revert AlreadyExecuted();
        if (approved[id][msg.sender]) revert AlreadyApproved();
        approved[id][msg.sender] = true;
        p.approvals += 1;
        emit Approved(id, msg.sender, p.approvals);

        if (p.approvals == threshold) {
            // Set the timelock clock. Sweeps move the ENTIRE balance, so they are
            // always treated as large and must wait withdrawDelay — otherwise a
            // thief with quorum keys could drain everything instantly via a sweep,
            // bypassing the timelock that guards large withdrawals. Regular
            // withdrawals wait only when at/above largeAmount; small ones are ready now.
            bool isSweep     = p.action == Action.SweepNative || p.action == Action.SweepToken;
            bool largeWithdraw = p.amount >= largeAmount && (p.action == Action.WithdrawNative || p.action == Action.WithdrawToken);
            bool large = isSweep || largeWithdraw;
            p.readyAt = block.timestamp + (large ? withdrawDelay : 0);
            emit QuorumReached(id, p.readyAt);
        }
    }

    // --------------------------- Execution ------------------------------ //
    function execute(uint256 id) external nonReentrant notPaused {
        Proposal storage p = proposals[id];
        if (p.to == address(0)) revert UnknownProposal();
        if (p.executed) revert AlreadyExecuted();
        if (p.approvals < threshold) revert ThresholdNotMet();
        if (block.timestamp < p.readyAt) revert TimelockNotElapsed();
        if (!isAllowed(p.to)) revert DestinationNotAllowed();

        p.executed = true;

        uint256 outValue;
        if (p.action == Action.WithdrawNative) {
            outValue = p.amount;
            _checkVelocity(outValue);
            _sendNative(p.to, p.amount);
        } else if (p.action == Action.SweepNative) {
            outValue = address(this).balance;
            _checkVelocity(outValue);
            _sendNative(p.to, outValue);
        } else if (p.action == Action.WithdrawToken) {
            _checkTokenVelocity(p.token, p.amount);
            _sendToken(p.token, p.to, p.amount);
        } else {
            uint256 tokAmt = _tokenBalance(p.token);
            _checkTokenVelocity(p.token, tokAmt);
            _sendToken(p.token, p.to, tokAmt);
        }

        emit Executed(id);
    }

    // --------------------------- Velocity ------------------------------- //
    function _checkVelocity(uint256 outValue) internal {
        // Roll the window if 24h elapsed.
        if (block.timestamp >= windowStart + 1 days) {
            windowStart = block.timestamp;
            spentInWindow = 0;
        }
        uint256 newSpent = spentInWindow + outValue;
        if (dailyLimit != 0 && newSpent > dailyLimit) revert VelocityExceeded();
        spentInWindow = newSpent;
    }

    /// Configure a per-token daily limit. Any single owner may SET (from unset) or
    /// LOWER a limit — tightening security is always safe to allow unilaterally.
    /// Raising or clearing an existing limit weakens security and is intentionally
    /// NOT permitted here (would require a governed quorum setter, planned v0.2);
    /// for v0, set-or-lower only.
    function setTokenLimitTighten(address token, uint256 newLimit) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        uint256 cur = tokenDailyLimit[token];
        if (cur != 0 && (newLimit == 0 || newLimit > cur)) revert NothingToChange();
        tokenDailyLimit[token] = newLimit;
        if (tokenWindowStart[token] == 0) tokenWindowStart[token] = block.timestamp;
    }

    /// Per-token rolling 24h cap (F1 fix). If no limit is configured for `token`
    /// (tokenDailyLimit == 0), token outflow is governed by allowlist + timelock
    /// only, same as before; setting a limit adds the velocity guard for that token.
    function _checkTokenVelocity(address token, uint256 outAmount) internal {
        uint256 limit = tokenDailyLimit[token];
        if (limit == 0) return; // not configured -> no extra cap
        if (block.timestamp >= tokenWindowStart[token] + 1 days) {
            tokenWindowStart[token] = block.timestamp;
            tokenSpentInWindow[token] = 0;
        }
        uint256 newSpent = tokenSpentInWindow[token] + outAmount;
        if (newSpent > limit) revert VelocityExceeded();
        tokenSpentInWindow[token] = newSpent;
    }

    // ------------------------- Transfer helpers ------------------------- //
    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
    function _sendToken(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
    function _tokenBalance(address token) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || data.length < 32) revert TransferFailed();
        return abi.decode(data, (uint256));
    }

    // ----------------------------- Views -------------------------------- //
    function ownerCount() external view returns (uint256) {
        return owners.length;
    }
    function getProposal(uint256 id)
        external view
        returns (Action action, address to, address token, uint256 amount, bool executed, uint256 approvals, uint256 readyAt)
    {
        Proposal storage p = proposals[id];
        return (p.action, p.to, p.token, p.amount, p.executed, p.approvals, p.readyAt);
    }
}
