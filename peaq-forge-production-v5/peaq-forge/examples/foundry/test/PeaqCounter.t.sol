// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/PeaqCounter.sol";

contract PeaqCounterTest is Test {
    PeaqCounter public counter;
    address public alice = makeAddr("alice");
    address public bob   = makeAddr("bob");

    function setUp() public {
        vm.prank(alice);
        counter = new PeaqCounter();
    }

    // ── Initial state ─────────────────────────────────────────────────────
    function test_InitialCountIsZero() public view {
        assertEq(counter.count(), 0);
    }

    function test_OwnerIsDeployer() public view {
        assertEq(counter.owner(), alice);
    }

    // ── Increment ─────────────────────────────────────────────────────────
    function test_IncrementIncreasesCount() public {
        counter.increment();
        assertEq(counter.count(), 1);
    }

    function test_IncrementEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit PeaqCounter.Incremented(address(this), 1);
        counter.increment();
    }

    function test_IncrementByAmount() public {
        counter.incrementBy(42);
        assertEq(counter.count(), 42);
    }

    function test_IncrementByZeroDoesNothing() public {
        counter.incrementBy(0);
        assertEq(counter.count(), 0);
    }

    function test_MultipleIncrements() public {
        counter.increment();
        counter.increment();
        counter.incrementBy(8);
        assertEq(counter.count(), 10);
    }

    // ── Fuzz ──────────────────────────────────────────────────────────────
    function testFuzz_IncrementBy(uint128 amount) public {
        vm.assume(amount > 0);
        counter.incrementBy(uint256(amount));
        assertEq(counter.count(), uint256(amount));
    }

    // ── Reset ─────────────────────────────────────────────────────────────
    function test_OwnerCanReset() public {
        counter.increment();
        counter.incrementBy(9);
        vm.prank(alice);
        counter.reset();
        assertEq(counter.count(), 0);
    }

    function test_NonOwnerCannotReset() public {
        counter.increment();
        vm.prank(bob);
        vm.expectRevert(PeaqCounter.NotOwner.selector);
        counter.reset();
    }

    function test_ResetEmitsEvent() public {
        counter.increment();
        vm.prank(alice);
        vm.expectEmit(true, false, false, false);
        emit PeaqCounter.Reset(alice);
        counter.reset();
    }

    // ── Overflow protection ───────────────────────────────────────────────
    function test_OverflowReverts() public {
        // Manipulate storage to set count to max
        uint256 slot = 0; // _count is slot 0
        vm.store(address(counter), bytes32(slot), bytes32(type(uint256).max));
        assertEq(counter.count(), type(uint256).max);
        vm.expectRevert(PeaqCounter.Overflow.selector);
        counter.increment();
    }
}
