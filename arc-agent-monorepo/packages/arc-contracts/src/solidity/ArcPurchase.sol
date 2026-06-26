// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ArcPurchase
 * @notice Executes stablecoin-settled (USDC) purchases on Arc network.
 *         Deployed on Arc Testnet (chain ID 5042002).
 *         Part of the Circle Arc smart contract library.
 *
 * @dev AI agents call purchase() after Circle Wallet policy validation.
 *      Settlement is deterministic — finality in <500ms on Arc.
 */
contract ArcPurchase is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ──────────────────────────────────────────────────────────

    IERC20 public immutable usdc;

    struct Purchase {
        address buyer;
        address merchant;
        uint256 amount;
        uint256 timestamp;
        bool settled;
        bytes32 orderId;
    }

    mapping(bytes32 => Purchase) public purchases;
    mapping(address => bool) public authorizedAgents;

    // ─── Events ─────────────────────────────────────────────────────────

    event PurchaseExecuted(
        bytes32 indexed orderId,
        address indexed buyer,
        address indexed merchant,
        uint256 amount
    );

    event PurchaseSettled(bytes32 indexed orderId);

    event AgentAuthorized(address indexed agent, bool authorized);

    // ─── Errors ──────────────────────────────────────────────────────────

    error UnauthorizedAgent(address agent);
    error OrderAlreadyExists(bytes32 orderId);
    error OrderNotFound(bytes32 orderId);
    error OrderAlreadySettled(bytes32 orderId);
    error InsufficientBalance(uint256 required, uint256 available);
    error ZeroAmount();
    error ZeroAddress();

    // ─── Constructor ─────────────────────────────────────────────────────

    constructor(address _usdc, address initialOwner) Ownable(initialOwner) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    // ─── Agent Authorization ─────────────────────────────────────────────

    function setAgentAuthorized(address agent, bool authorized) external onlyOwner {
        authorizedAgents[agent] = authorized;
        emit AgentAuthorized(agent, authorized);
    }

    modifier onlyAuthorizedAgent() {
        if (!authorizedAgents[msg.sender] && msg.sender != owner()) {
            revert UnauthorizedAgent(msg.sender);
        }
        _;
    }

    // ─── Core Functions ───────────────────────────────────────────────────

    /**
     * @notice Execute a USDC purchase. Transfers from buyer to merchant atomically.
     * @param token   USDC token address (must match immutable usdc)
     * @param amount  Amount in USDC units (6 decimals)
     * @param merchant Merchant wallet address
     * @param orderId Unique order identifier (bytes32)
     * @return success True if purchase executed successfully
     */
    function purchase(
        address token,
        uint256 amount,
        address merchant,
        bytes32 orderId
    ) external nonReentrant onlyAuthorizedAgent returns (bool) {
        if (amount == 0) revert ZeroAmount();
        if (merchant == address(0)) revert ZeroAddress();
        if (purchases[orderId].timestamp != 0) revert OrderAlreadyExists(orderId);

        // Check buyer has sufficient allowance
        uint256 allowance = usdc.allowance(msg.sender, address(this));
        if (allowance < amount) revert InsufficientBalance(amount, allowance);

        // Record before transfer (checks-effects-interactions)
        purchases[orderId] = Purchase({
            buyer: msg.sender,
            merchant: merchant,
            amount: amount,
            timestamp: block.timestamp,
            settled: false,
            orderId: orderId
        });

        // Execute transfer: buyer → merchant
        usdc.safeTransferFrom(msg.sender, merchant, amount);

        emit PurchaseExecuted(orderId, msg.sender, merchant, amount);
        return true;
    }

    /**
     * @notice Get purchase details by order ID.
     */
    function getPurchase(bytes32 orderId)
        external
        view
        returns (
            address buyer,
            address merchant,
            uint256 amount,
            uint256 timestamp,
            bool settled
        )
    {
        Purchase memory p = purchases[orderId];
        if (p.timestamp == 0) revert OrderNotFound(orderId);
        return (p.buyer, p.merchant, p.amount, p.timestamp, p.settled);
    }

    /**
     * @notice Mark a purchase as settled (post-delivery confirmation).
     */
    function settlePurchase(bytes32 orderId) external onlyAuthorizedAgent returns (bool) {
        Purchase storage p = purchases[orderId];
        if (p.timestamp == 0) revert OrderNotFound(orderId);
        if (p.settled) revert OrderAlreadySettled(orderId);

        p.settled = true;
        emit PurchaseSettled(orderId);
        return true;
    }
}
