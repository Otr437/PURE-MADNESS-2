// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title PeaqCounter
 * @notice Simple counter contract — Foundry example for peaq EVM.
 *         Demonstrates forge build/test/create workflow.
 */
contract PeaqCounter {
    uint256 private _count;
    address public  owner;

    event Incremented(address indexed by, uint256 newCount);
    event Reset(address indexed by);

    error NotOwner();
    error Overflow();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function increment() external {
        if (_count == type(uint256).max) revert Overflow();
        unchecked { _count++; }
        emit Incremented(msg.sender, _count);
    }

    function incrementBy(uint256 amount) external {
        if (amount == 0) return;
        if (_count > type(uint256).max - amount) revert Overflow();
        unchecked { _count += amount; }
        emit Incremented(msg.sender, _count);
    }

    function reset() external onlyOwner {
        _count = 0;
        emit Reset(msg.sender);
    }

    function count() external view returns (uint256) {
        return _count;
    }
}
