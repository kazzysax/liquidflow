// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PlatformWallet
/// @notice A builder-owned smart account where payment funds settle.
///
/// Non-custodial guarantees enforced by this contract (not by any off-chain server):
///   1. Only the builder's configured owner-set can authorize moving funds.
///   2. Moving funds requires a quorum of owner approvals (2-of-N by default).
///   3. Liquid Flow is NOT an owner and holds no power here. There is no operator,
///      admin, or backdoor role that can move, redirect, freeze, or seize funds.
///   4. The builder can sweep the entire balance to any external address they
///      choose, at will, subject only to the same owner quorum.
///
/// What Liquid Flow can do with this contract: nothing that moves funds. It can
/// only read balances/events. All fund movement is gated on builder owner signatures.
///
/// Design notes:
///   * Withdrawals and sweeps use a propose -> approve -> execute pattern. An owner
///     proposes; distinct owners approve; once `threshold` approvals exist, anyone
///     may trigger execution (execution has no privilege — the approvals are the gate).
///   * Pull-free, checks-effects-interactions ordering, explicit reentrancy guard.
///   * Native coin (ETH) supported via receive(); ERC-20 via token withdrawals.
contract PlatformWallet {
    // --------------------------------------------------------------------- //
    // Errors (gas-cheap, explicit)
    // --------------------------------------------------------------------- //
    error NotOwner();
    error AlreadyOwner();
    error ZeroAddress();
    error InvalidThreshold();
    error UnknownProposal();
    error AlreadyApproved();
    error AlreadyExecuted();
    error ThresholdNotMet();
    error TransferFailed();
    error Reentrancy();
    error NothingToChange();

    // --------------------------------------------------------------------- //
    // Ownership / quorum (the builder's control set)
    // --------------------------------------------------------------------- //
    mapping(address => bool) public isOwner;
    address[] public owners;
    /// @notice Number of distinct owner approvals required to move funds.
    uint256 public threshold;

    // --------------------------------------------------------------------- //
    // Proposals
    // --------------------------------------------------------------------- //
    enum Action {
        WithdrawNative, // move native coin to `to`
        WithdrawToken, // move ERC-20 `token` to `to`
        SweepNative, // move ALL native coin to `to`
        SweepToken // move ALL of ERC-20 `token` to `to`
    }

    struct Proposal {
        Action action;
        address to; // destination (builder-chosen external address allowed)
        address token; // ERC-20 address (ignored for native actions)
        uint256 amount; // amount (ignored for sweep actions)
        bool executed;
        uint256 approvals;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public approved;

    // --------------------------------------------------------------------- //
    // Reentrancy guard
    // --------------------------------------------------------------------- //
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

    // --------------------------------------------------------------------- //
    // Events
    // --------------------------------------------------------------------- //
    event Deposit(address indexed from, uint256 amount);
    event ProposalCreated(uint256 indexed id, Action action, address indexed to, address token, uint256 amount);
    event Approved(uint256 indexed id, address indexed owner, uint256 approvals);
    event Executed(uint256 indexed id);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 threshold);

    // --------------------------------------------------------------------- //
    // Construction
    // --------------------------------------------------------------------- //
    /// @param initialOwners The builder's owner set (e.g. builder key + co-signer).
    /// @param initialThreshold Approvals required (e.g. 2). Must be 1..N and >=1.
    /// @dev Liquid Flow is deliberately NOT passed in and cannot be an owner.
    constructor(address[] memory initialOwners, uint256 initialThreshold) {
        uint256 n = initialOwners.length;
        if (initialThreshold == 0 || initialThreshold > n) revert InvalidThreshold();
        for (uint256 i = 0; i < n; i++) {
            address o = initialOwners[i];
            if (o == address(0)) revert ZeroAddress();
            if (isOwner[o]) revert AlreadyOwner();
            isOwner[o] = true;
            owners.push(o);
            emit OwnerAdded(o);
        }
        threshold = initialThreshold;
        emit ThresholdChanged(initialThreshold);
    }

    // --------------------------------------------------------------------- //
    // Receiving funds — anyone may deposit; settlement lands here.
    // --------------------------------------------------------------------- //
    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    // --------------------------------------------------------------------- //
    // Proposing fund movement (owner only)
    // --------------------------------------------------------------------- //
    function proposeWithdrawNative(address to, uint256 amount) external onlyOwner returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        return _createProposal(Action.WithdrawNative, to, address(0), amount);
    }

    function proposeWithdrawToken(address token, address to, uint256 amount)
        external
        onlyOwner
        returns (uint256)
    {
        if (to == address(0) || token == address(0)) revert ZeroAddress();
        return _createProposal(Action.WithdrawToken, to, token, amount);
    }

    /// @notice Sweep the entire native balance to a builder-chosen address.
    function proposeSweepNative(address to) external onlyOwner returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        return _createProposal(Action.SweepNative, to, address(0), 0);
    }

    /// @notice Sweep the entire balance of a token to a builder-chosen address.
    function proposeSweepToken(address token, address to) external onlyOwner returns (uint256) {
        if (to == address(0) || token == address(0)) revert ZeroAddress();
        return _createProposal(Action.SweepToken, to, token, 0);
    }

    function _createProposal(Action action, address to, address token, uint256 amount)
        internal
        returns (uint256 id)
    {
        id = proposalCount++;
        Proposal storage p = proposals[id];
        p.action = action;
        p.to = to;
        p.token = token;
        p.amount = amount;
        emit ProposalCreated(id, action, to, token, amount);
        // The proposer's own approval is counted immediately.
        _approve(id);
    }

    // --------------------------------------------------------------------- //
    // Approving (owner only) — distinct owners reach the quorum
    // --------------------------------------------------------------------- //
    function approve(uint256 id) external onlyOwner {
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
    }

    // --------------------------------------------------------------------- //
    // Execution — permissionless trigger, but only valid once quorum is met.
    // Execution carries NO privilege; the approvals ARE the authorization, so it
    // is safe for anyone (including an automated relayer) to call. Liquid Flow
    // triggering this is just pressing "go" on something owners already authorized.
    // --------------------------------------------------------------------- //
    function execute(uint256 id) external nonReentrant {
        Proposal storage p = proposals[id];
        if (p.to == address(0)) revert UnknownProposal();
        if (p.executed) revert AlreadyExecuted();
        if (p.approvals < threshold) revert ThresholdNotMet();

        // Effects before interactions.
        p.executed = true;

        if (p.action == Action.WithdrawNative) {
            _sendNative(p.to, p.amount);
        } else if (p.action == Action.SweepNative) {
            _sendNative(p.to, address(this).balance);
        } else if (p.action == Action.WithdrawToken) {
            _sendToken(p.token, p.to, p.amount);
        } else {
            // SweepToken
            _sendToken(p.token, p.to, _tokenBalance(p.token));
        }

        emit Executed(id);
    }

    // --------------------------------------------------------------------- //
    // Owner-set management — same quorum protects changes to the owner set.
    // (Changes also go through propose/approve to avoid a single owner unilaterally
    //  altering control. Implemented via dedicated proposals in a later revision;
    //  for v0 these are owner-guarded direct calls requiring threshold via the
    //  same proposal mechanism would be added. Kept minimal & explicit here.)
    // --------------------------------------------------------------------- //
    // NOTE: owner-set mutation intentionally omitted from v0 to keep the audited
    // surface minimal. Deploy with the final owner set. A governed add/remove
    // (behind the same quorum) is a planned v0.2 addition.

    // --------------------------------------------------------------------- //
    // Internal transfer helpers
    // --------------------------------------------------------------------- //
    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _sendToken(address token, address to, uint256 amount) internal {
        // ERC-20 transfer via low-level call; tolerate non-standard tokens that
        // return no boolean (e.g. USDT). Success = call succeeded AND (no return
        // data OR return data decodes to true).
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _tokenBalance(address token) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || data.length < 32) revert TransferFailed();
        return abi.decode(data, (uint256));
    }

    // --------------------------------------------------------------------- //
    // Views
    // --------------------------------------------------------------------- //
    function ownerCount() external view returns (uint256) {
        return owners.length;
    }

    function getProposal(uint256 id)
        external
        view
        returns (Action action, address to, address token, uint256 amount, bool executed, uint256 approvals)
    {
        Proposal storage p = proposals[id];
        return (p.action, p.to, p.token, p.amount, p.executed, p.approvals);
    }
}
