// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ArcSubscription
 * @notice Manages recurring USDC subscription payments on Arc network.
 *         AI agents call renewSubscription() via BullMQ-scheduled jobs.
 *
 * @dev Each subscription stores the next payment timestamp. Agents check
 *      this on-chain before scheduling renewal jobs — no double-charge risk.
 */
contract ArcSubscription is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    struct Subscription {
        address subscriber;
        address merchant;
        uint256 amount;           // USDC per period (6 decimals)
        uint256 periodSeconds;    // e.g., 2592000 = 30 days
        uint256 nextPaymentAt;    // Unix timestamp
        bool active;
        bytes32 subscriptionId;
    }

    mapping(bytes32 => Subscription) public subscriptions;
    mapping(address => bool) public authorizedAgents;

    event SubscriptionCreated(
        bytes32 indexed subscriptionId,
        address indexed subscriber,
        address indexed merchant,
        uint256 amount,
        uint256 periodSeconds
    );

    event SubscriptionRenewed(
        bytes32 indexed subscriptionId,
        uint256 nextPaymentAt,
        uint256 amountPaid
    );

    event SubscriptionCancelled(bytes32 indexed subscriptionId);

    error UnauthorizedAgent(address agent);
    error SubscriptionNotFound(bytes32 id);
    error SubscriptionInactive(bytes32 id);
    error RenewalNotDue(bytes32 id, uint256 dueAt, uint256 now_);
    error ZeroAmount();
    error ZeroAddress();

    constructor(address _usdc, address initialOwner) Ownable(initialOwner) {
        usdc = IERC20(_usdc);
    }

    function setAgentAuthorized(address agent, bool authorized) external onlyOwner {
        authorizedAgents[agent] = authorized;
    }

    modifier onlyAuthorizedAgent() {
        if (!authorizedAgents[msg.sender] && msg.sender != owner()) {
            revert UnauthorizedAgent(msg.sender);
        }
        _;
    }

    /**
     * @notice Create a new recurring subscription.
     * @param token         USDC address
     * @param merchant      Merchant receiving payments
     * @param amount        USDC amount per period
     * @param periodSeconds Seconds between payments (e.g., 2592000 for 30 days)
     * @return subscriptionId Unique identifier for the subscription
     */
    function createSubscription(
        address token,
        address merchant,
        uint256 amount,
        uint256 periodSeconds
    ) external nonReentrant onlyAuthorizedAgent returns (bytes32) {
        if (amount == 0) revert ZeroAmount();
        if (merchant == address(0)) revert ZeroAddress();

        bytes32 subscriptionId = keccak256(
            abi.encodePacked(msg.sender, merchant, amount, periodSeconds, block.timestamp)
        );

        // Execute first payment immediately
        usdc.safeTransferFrom(msg.sender, merchant, amount);

        subscriptions[subscriptionId] = Subscription({
            subscriber: msg.sender,
            merchant: merchant,
            amount: amount,
            periodSeconds: periodSeconds,
            nextPaymentAt: block.timestamp + periodSeconds,
            active: true,
            subscriptionId: subscriptionId
        });

        emit SubscriptionCreated(subscriptionId, msg.sender, merchant, amount, periodSeconds);
        return subscriptionId;
    }

    /**
     * @notice Renew a subscription. Can only be called on or after nextPaymentAt.
     * @param subscriptionId The subscription to renew
     * @return success True if renewal succeeded
     */
    function renewSubscription(bytes32 subscriptionId)
        external
        nonReentrant
        onlyAuthorizedAgent
        returns (bool)
    {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.nextPaymentAt == 0) revert SubscriptionNotFound(subscriptionId);
        if (!sub.active) revert SubscriptionInactive(subscriptionId);
        if (block.timestamp < sub.nextPaymentAt) {
            revert RenewalNotDue(subscriptionId, sub.nextPaymentAt, block.timestamp);
        }

        sub.nextPaymentAt = block.timestamp + sub.periodSeconds;
        usdc.safeTransferFrom(sub.subscriber, sub.merchant, sub.amount);

        emit SubscriptionRenewed(subscriptionId, sub.nextPaymentAt, sub.amount);
        return true;
    }

    /**
     * @notice Cancel a subscription. Only subscriber or authorized agent can cancel.
     */
    function cancelSubscription(bytes32 subscriptionId)
        external
        onlyAuthorizedAgent
        returns (bool)
    {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.nextPaymentAt == 0) revert SubscriptionNotFound(subscriptionId);
        if (!sub.active) revert SubscriptionInactive(subscriptionId);

        sub.active = false;
        emit SubscriptionCancelled(subscriptionId);
        return true;
    }

    function getSubscription(bytes32 subscriptionId)
        external
        view
        returns (
            address subscriber,
            address merchant,
            uint256 amount,
            uint256 nextPaymentAt,
            bool active
        )
    {
        Subscription memory sub = subscriptions[subscriptionId];
        if (sub.nextPaymentAt == 0) revert SubscriptionNotFound(subscriptionId);
        return (sub.subscriber, sub.merchant, sub.amount, sub.nextPaymentAt, sub.active);
    }
}
