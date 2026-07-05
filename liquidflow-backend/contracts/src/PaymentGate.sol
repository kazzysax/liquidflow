// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PaymentGate
/// @notice Per-merchant deposit gate for the Integrate Payment System.
///
/// Model (from integrate-payment-spec.md):
///   * The merchant's payout address is HARDCODED at deployment and can never be
///     changed by anyone — funds have exactly one possible destination.
///   * Liquid Flow holds an "operator" key whose ONLY power is to open a gate for a
///     specific payment (paymentId, expected amount, expiry) and close it. The
///     operator can NEVER withdraw, redirect, or change the merchant. It is a
///     timing/authorization key, not a money key.
///   * When no payment is open for an incoming native transfer, the contract
///     REVERTS — deposits are rejected at a closed gate (true on-chain gate for
///     native coin). Matching native payments are forwarded INSTANTLY to the
///     merchant; funds never rest in this contract.
///   * ERC-20 / non-EVM cannot be rejected on-chain (the token doesn't call us on
///     receive); for those the off-chain accounting gate + auto-refund applies.
///     This contract documents that and supports an operator-confirmed settle path
///     for tokens that still only ever pays the hardcoded merchant.
///
/// Non-custodial: there is no function by which the operator (Liquid Flow) can
/// move funds anywhere other than the immutable merchant address.
contract PaymentGate {
    // ------------------------------ Errors --------------------------------- //
    error NotOperator();
    error GateClosed();
    error WrongAmount();
    error PaymentExpired();
    error PaymentNotOpen();
    error AlreadyUsed();
    error ZeroAddress();
    error TransferFailed();
    error Reentrancy();

    // --------------------------- Immutable config -------------------------- //
    /// The only address funds can ever reach. Set once, forever.
    address public immutable merchant;
    /// Liquid Flow's operator key — can open/close gates only.
    address public immutable operator;

    // ------------------------------ State ---------------------------------- //
    struct Payment {
        uint256 amount;   // exact expected amount (wei) — 0 means "any" disabled
        uint64 expiry;    // unix time after which the gate auto-closes
        bool open;        // operator opened this payment
        bool settled;     // funds received + forwarded (or token-confirmed)
    }
    /// paymentId => Payment. paymentId is a unique reference per payment (keccak of
    /// the platform's order id, etc.), so one gate contract serves all payments.
    mapping(bytes32 => Payment) public payments;

    uint256 private _lock = 1;
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }
    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    // ------------------------------ Events --------------------------------- //
    event PaymentOpened(bytes32 indexed paymentId, uint256 amount, uint64 expiry);
    event PaymentClosed(bytes32 indexed paymentId);
    event PaymentSettled(bytes32 indexed paymentId, uint256 amount, address indexed to);
    event TokenSettled(bytes32 indexed paymentId, address indexed token, uint256 amount, address indexed to);

    constructor(address merchant_, address operator_) {
        if (merchant_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        merchant = merchant_;
        operator = operator_;
    }

    // ------------------- Operator: open / close a gate --------------------- //
    /// Open a gate for a specific payment. Operator-only. Cannot touch funds.
    function openPayment(bytes32 paymentId, uint256 amount, uint64 expiry) external onlyOperator {
        Payment storage p = payments[paymentId];
        if (p.open || p.settled) revert AlreadyUsed();
        // A zero amount would mean "accept any value" (native) and "sweep the whole
        // contract balance" (settleToken) — an open-ended gate that could scoop
        // tokens meant for other payments. Every real payment has an exact amount.
        if (amount == 0) revert WrongAmount();
        p.amount = amount;
        p.expiry = expiry;
        p.open = true;
        emit PaymentOpened(paymentId, amount, expiry);
    }

    /// Close a gate (e.g. payment abandoned). Operator-only. Cannot touch funds.
    function closePayment(bytes32 paymentId) external onlyOperator {
        Payment storage p = payments[paymentId];
        if (!p.open) revert PaymentNotOpen();
        p.open = false;
        emit PaymentClosed(paymentId);
    }

    // --------------------- Payer: pay a native gate ------------------------ //
    /// Pay an open native-coin gate. Reverts if the gate is closed/expired or the
    /// amount is wrong (true on-chain rejection). On success, funds are forwarded
    /// INSTANTLY to the immutable merchant address — never held here.
    function pay(bytes32 paymentId) external payable nonReentrant {
        Payment storage p = payments[paymentId];
        if (!p.open) revert GateClosed();
        if (block.timestamp > p.expiry) revert PaymentExpired();
        if (p.amount != 0 && msg.value != p.amount) revert WrongAmount();

        // effects before interaction
        p.open = false;
        p.settled = true;

        // forward straight to the merchant; funds do not rest in this contract
        (bool ok,) = payable(merchant).call{value: msg.value}("");
        if (!ok) revert TransferFailed();
        emit PaymentSettled(paymentId, msg.value, merchant);
    }

    /// Reject any stray native transfer that isn't a `pay()` for an open gate.
    /// This is the on-chain "closed gate rejects deposits" guarantee for native coin.
    receive() external payable {
        revert GateClosed();
    }

    // ------------- Token settle (accounting gate, operator-confirmed) ------ //
    /// For ERC-20: the token cannot be rejected on receipt, so tokens may arrive
    /// at this contract regardless. The operator confirms a matching deposit and
    /// triggers forwarding — but ONLY ever to the immutable merchant. If no
    /// payment matches, off-chain logic issues a refund (see spec §14.1); this
    /// function cannot send anywhere but `merchant`, so the operator still cannot
    /// steal. Amount is read from the token balance to avoid trusting input.
    function settleToken(bytes32 paymentId, address token) external onlyOperator nonReentrant {
        Payment storage p = payments[paymentId];
        if (!p.open) revert PaymentNotOpen();
        if (block.timestamp > p.expiry) revert PaymentExpired();

        uint256 bal = _tokenBalance(token);
        if (p.amount != 0 && bal < p.amount) revert WrongAmount();
        uint256 amount = p.amount != 0 ? p.amount : bal;

        p.open = false;
        p.settled = true;

        _sendToken(token, merchant, amount);
        emit TokenSettled(paymentId, token, amount, merchant);
    }

    // ----------------------------- Helpers --------------------------------- //
    function _sendToken(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _tokenBalance(address token) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || data.length < 32) revert TransferFailed();
        return abi.decode(data, (uint256));
    }

    function getPayment(bytes32 paymentId)
        external view
        returns (uint256 amount, uint64 expiry, bool open, bool settled)
    {
        Payment storage p = payments[paymentId];
        return (p.amount, p.expiry, p.open, p.settled);
    }
}
