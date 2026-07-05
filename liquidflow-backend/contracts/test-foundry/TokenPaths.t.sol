// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import "../src/SecurePlatformWallet.sol";
import "../src/PaymentGate.sol";
import "./mocks/MockERC20.sol";

/// Closes the #1 gap from GO-LIVE-STATUS.md: the JS suites only exercised NATIVE
/// coin. These tests exercise the ERC-20 token paths and assert the core
/// non-custodial invariant — tokens can ONLY ever reach the merchant.
contract TokenPathsTest is Test {
    SecurePlatformWallet wallet;
    MockERC20 token;
    MockNoReturnERC20 oddToken;

    address ownerA = address(0xA11CE);
    address ownerB = address(0xB0B);
    address guardian = address(0x6A11D);
    address merchant = address(0x1234);
    address attacker = address(0xBAD);

    uint256 constant LARGE = 1000 ether;       // high so token tests skip timelock
    uint256 constant TOKEN_DAILY = 100 ether;  // per-token velocity cap under test

    function setUp() public {
        address[] memory owners = new address[](2);
        owners[0] = ownerA;
        owners[1] = ownerB;
        // threshold 2, guardian, withdrawDelay 1h, large 1000e18, allowlistDelay 1h, native daily 100e18
        wallet = new SecurePlatformWallet(owners, 2, guardian, 1 hours, LARGE, 1 hours, 100 ether);

        token = new MockERC20();
        token.mint(address(wallet), 1000 ether);

        oddToken = new MockNoReturnERC20();
        oddToken.mint(address(wallet), 1000 ether);

        // allowlist the merchant (the only legit payout destination)
        vm.prank(ownerA);
        wallet.proposeAllowlist(merchant);
        vm.warp(block.timestamp + 1 hours + 1);
        wallet.activateAllowlist(merchant);
    }

    // ---- helpers ------------------------------------------------------------ //
    function _withdrawToken(address tkn, address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(ownerA);
        id = wallet.proposeWithdrawToken(tkn, to, amount); // A approves on create
        vm.prank(ownerB);
        wallet.approve(id);                                  // quorum reached
        wallet.execute(id);                                  // permissionless trigger
    }

    // ---- happy path: tokens reach the merchant, nothing rests in the wallet -- //
    function test_TokenWithdrawal_ReachesMerchantOnly() public {
        _withdrawToken(address(token), merchant, 40 ether);
        assertEq(token.balanceOf(merchant), 40 ether, "merchant received tokens");
        assertEq(token.balanceOf(address(wallet)), 960 ether, "wallet debited exactly");
    }

    function test_NonStandardToken_NoReturnData_Works() public {
        // USDT-style token returning no data must still settle via tolerant _sendToken
        _withdrawToken(address(oddToken), merchant, 25 ether);
        assertEq(oddToken.balanceOf(merchant), 25 ether);
    }

    function test_SweepToken_SendsFullBalanceToMerchant() public {
        vm.prank(ownerA);
        uint256 id = wallet.proposeSweepToken(address(token), merchant);
        vm.prank(ownerB);
        wallet.approve(id);
        wallet.execute(id);
        assertEq(token.balanceOf(merchant), 1000 ether);
        assertEq(token.balanceOf(address(wallet)), 0);
    }

    // ---- the #1 invariant: cannot send tokens to a non-allowlisted address --- //
    function test_CannotWithdrawTokensToNonAllowlisted() public {
        vm.prank(ownerA);
        vm.expectRevert(SecurePlatformWallet.DestinationNotAllowed.selector);
        wallet.proposeWithdrawToken(address(token), attacker, 10 ether);
    }

    // ---- per-token velocity cap (setTokenLimitTighten) ---------------------- //
    function test_PerTokenVelocityCap_Holds() public {
        vm.prank(ownerA);
        wallet.setTokenLimitTighten(address(token), TOKEN_DAILY);

        _withdrawToken(address(token), merchant, 60 ether); // spent 60/100

        // 60 + 50 = 110 > 100 -> blocked
        vm.prank(ownerA);
        uint256 id = wallet.proposeWithdrawToken(address(token), merchant, 50 ether);
        vm.prank(ownerB);
        wallet.approve(id);
        vm.expectRevert(SecurePlatformWallet.VelocityExceeded.selector);
        wallet.execute(id);

        // 60 + 40 = 100 == cap -> allowed (boundary)
        _withdrawToken(address(token), merchant, 40 ether);
        assertEq(token.balanceOf(merchant), 100 ether);
    }

    function test_PerTokenVelocity_WindowRollsAfter24h() public {
        vm.prank(ownerA);
        wallet.setTokenLimitTighten(address(token), TOKEN_DAILY);

        _withdrawToken(address(token), merchant, 100 ether); // fills the window

        // next withdrawal in the same window is blocked
        vm.prank(ownerA);
        uint256 id = wallet.proposeWithdrawToken(address(token), merchant, 10 ether);
        vm.prank(ownerB);
        wallet.approve(id);
        vm.expectRevert(SecurePlatformWallet.VelocityExceeded.selector);
        wallet.execute(id);

        // after 24h the window rolls and withdrawals resume
        vm.warp(block.timestamp + 1 days + 1);
        _withdrawToken(address(token), merchant, 80 ether);
        assertEq(token.balanceOf(merchant), 180 ether);
    }

    function test_SetTokenLimitTighten_CannotRaiseOrClear() public {
        vm.startPrank(ownerA);
        wallet.setTokenLimitTighten(address(token), TOKEN_DAILY);
        // raising is rejected (security may only tighten)
        vm.expectRevert(SecurePlatformWallet.NothingToChange.selector);
        wallet.setTokenLimitTighten(address(token), TOKEN_DAILY + 1);
        // clearing to 0 is rejected
        vm.expectRevert(SecurePlatformWallet.NothingToChange.selector);
        wallet.setTokenLimitTighten(address(token), 0);
        // lowering is allowed
        wallet.setTokenLimitTighten(address(token), TOKEN_DAILY - 10 ether);
        vm.stopPrank();
        assertEq(wallet.tokenDailyLimit(address(token)), TOKEN_DAILY - 10 ether);
    }
}

/// PaymentGate token settle path — operator-confirmed, pays ONLY the immutable merchant.
contract PaymentGateTokenTest is Test {
    PaymentGate gate;
    MockERC20 token;

    address merchant = address(0x1234);
    address operator = address(0x09E7A);
    address attacker = address(0xBAD);

    bytes32 constant PID = keccak256("order-42");

    function setUp() public {
        gate = new PaymentGate(merchant, operator);
        token = new MockERC20();
    }

    function test_SettleToken_PaysImmutableMerchant() public {
        vm.prank(operator);
        gate.openPayment(PID, 100 ether, uint64(block.timestamp + 1 hours));

        // payer sends tokens to the gate (ERC-20 cannot be rejected on receive)
        token.mint(address(gate), 100 ether);

        vm.prank(operator);
        gate.settleToken(PID, address(token));

        assertEq(token.balanceOf(merchant), 100 ether, "merchant got the tokens");
        assertEq(token.balanceOf(address(gate)), 0, "gate holds nothing");
        (, , bool open, bool settled) = gate.getPayment(PID);
        assertFalse(open);
        assertTrue(settled);
    }

    function test_SettleToken_AnyAmountWhenZero() public {
        vm.prank(operator);
        gate.openPayment(PID, 0, uint64(block.timestamp + 1 hours)); // 0 == accept actual balance
        token.mint(address(gate), 77 ether);
        vm.prank(operator);
        gate.settleToken(PID, address(token));
        assertEq(token.balanceOf(merchant), 77 ether);
    }

    function test_SettleToken_OnlyOperator() public {
        vm.prank(operator);
        gate.openPayment(PID, 100 ether, uint64(block.timestamp + 1 hours));
        token.mint(address(gate), 100 ether);
        vm.prank(attacker);
        vm.expectRevert(PaymentGate.NotOperator.selector);
        gate.settleToken(PID, address(token));
    }

    function test_SettleToken_RevertsIfNoOpenPayment() public {
        token.mint(address(gate), 100 ether);
        vm.prank(operator);
        vm.expectRevert(PaymentGate.PaymentNotOpen.selector);
        gate.settleToken(PID, address(token));
    }

    function test_SettleToken_RevertsAfterExpiry() public {
        vm.prank(operator);
        gate.openPayment(PID, 100 ether, uint64(block.timestamp + 1 hours));
        token.mint(address(gate), 100 ether);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        vm.expectRevert(PaymentGate.PaymentExpired.selector);
        gate.settleToken(PID, address(token));
    }

    function test_SettleToken_RevertsIfUnderpaid() public {
        vm.prank(operator);
        gate.openPayment(PID, 100 ether, uint64(block.timestamp + 1 hours));
        token.mint(address(gate), 99 ether); // short
        vm.prank(operator);
        vm.expectRevert(PaymentGate.WrongAmount.selector);
        gate.settleToken(PID, address(token));
    }

    /// Structural non-custodial guarantee: the only destination is the immutable
    /// merchant set at construction — there is no operator-controlled recipient param.
    function test_MerchantIsImmutable() public view {
        assertEq(gate.merchant(), merchant);
    }
}
