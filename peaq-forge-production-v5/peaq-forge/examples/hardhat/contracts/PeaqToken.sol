// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title PeaqToken
 * @notice Standard ERC20 token with mint, burn, pause, and ownership controls.
 *         Suitable for deployment on peaq Mainnet, Agung Testnet, or Krest.
 * @dev    Inherits OpenZeppelin audited contracts. Owner can mint, pause, and transfer ownership.
 */
contract PeaqToken is ERC20, ERC20Burnable, Ownable, Pausable {

    uint8  private immutable _decimals;
    uint256 public  immutable MAX_SUPPLY;

    event Minted(address indexed to, uint256 amount);
    event Paused(address account);
    event Unpaused(address account);

    error ExceedsMaxSupply(uint256 requested, uint256 available);

    /**
     * @param name_      Token name e.g. "My peaq Token"
     * @param symbol_    Token symbol e.g. "MPT"
     * @param decimals_  Token decimals (typically 18)
     * @param maxSupply_ Maximum token supply (use 0 for unlimited)
     * @param initialMint Amount to mint to deployer immediately
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint8  decimals_,
        uint256 maxSupply_,
        uint256 initialMint
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        _decimals = decimals_;
        MAX_SUPPLY = maxSupply_;
        if (initialMint > 0) {
            if (maxSupply_ > 0 && initialMint > maxSupply_) revert ExceedsMaxSupply(initialMint, maxSupply_);
            _mint(msg.sender, initialMint);
            emit Minted(msg.sender, initialMint);
        }
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Mint additional tokens. Only callable by owner.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        if (MAX_SUPPLY > 0) {
            uint256 available = MAX_SUPPLY - totalSupply();
            if (amount > available) revert ExceedsMaxSupply(amount, available);
        }
        _mint(to, amount);
        emit Minted(to, amount);
    }

    /**
     * @notice Pause all token transfers. Only callable by owner.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause token transfers. Only callable by owner.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Hook that enforces pause state on all transfers.
     */
    function _update(address from, address to, uint256 value)
        internal
        override
        whenNotPaused
    {
        super._update(from, to, value);
    }
}
