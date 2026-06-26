// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ArcStream
 * @notice Per-second USDC streaming payments on Arc network.
 *         Enables agents to stream payments continuously at sub-cent rates.
 *
 * @dev Implements a deposit-and-drip model:
 *      - Sender deposits USDC upfront
 *      - Contract tracks earned balance per second
 *      - Receiver withdraws accrued balance at any time
 *      - Remaining deposit refundable on stream cancel
 */
contract ArcStream is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    struct Stream {
        address sender;
        address receiver;
        uint256 ratePerSecond;      // USDC units per second (6 decimals)
        uint256 deposit;            // Total deposited USDC
        uint256 withdrawn;          // Total withdrawn by receiver
        uint256 startTime;          // Unix timestamp stream started
        uint256 pausedAt;           // Unix timestamp when paused (0 if running)
        uint256 pausedDuration;     // Accumulated paused seconds
        bool cancelled;
        bytes32 streamId;
    }

    mapping(bytes32 => Stream) public streams;
    mapping(address => bool) public authorizedAgents;

    event StreamCreated(
        bytes32 indexed streamId,
        address indexed sender,
        address indexed receiver,
        uint256 ratePerSecond,
        uint256 deposit
    );
    event StreamWithdrawn(bytes32 indexed streamId, address indexed receiver, uint256 amount);
    event StreamPaused(bytes32 indexed streamId);
    event StreamResumed(bytes32 indexed streamId);
    event StreamCancelled(bytes32 indexed streamId, uint256 refunded);

    error StreamNotFound(bytes32 id);
    error StreamAlreadyCancelled(bytes32 id);
    error StreamNotPaused(bytes32 id);
    error StreamAlreadyPaused(bytes32 id);
    error NotReceiver(bytes32 id);
    error NotSender(bytes32 id);
    error InsufficientDeposit();
    error ZeroRate();
    error ZeroDeposit();

    constructor(address _usdc, address initialOwner) Ownable(initialOwner) {
        usdc = IERC20(_usdc);
    }

    function setAgentAuthorized(address agent, bool authorized) external onlyOwner {
        authorizedAgents[agent] = authorized;
    }

    /**
     * @notice Create a new streaming payment at a given rate per second.
     * @param token          USDC address
     * @param receiver       Who receives the stream
     * @param ratePerSecond  USDC units per second (e.g., 100 = $0.0001/s)
     * @param deposit        Upfront USDC deposit to fund the stream
     * @return streamId      Unique stream identifier
     */
    function createStream(
        address token,
        address receiver,
        uint256 ratePerSecond,
        uint256 deposit
    ) external nonReentrant returns (bytes32) {
        if (ratePerSecond == 0) revert ZeroRate();
        if (deposit == 0) revert ZeroDeposit();
        // Deposit must cover at least 60 seconds of streaming
        if (deposit < ratePerSecond * 60) revert InsufficientDeposit();

        bytes32 streamId = keccak256(
            abi.encodePacked(msg.sender, receiver, ratePerSecond, block.timestamp)
        );

        usdc.safeTransferFrom(msg.sender, address(this), deposit);

        streams[streamId] = Stream({
            sender: msg.sender,
            receiver: receiver,
            ratePerSecond: ratePerSecond,
            deposit: deposit,
            withdrawn: 0,
            startTime: block.timestamp,
            pausedAt: 0,
            pausedDuration: 0,
            cancelled: false,
            streamId: streamId
        });

        emit StreamCreated(streamId, msg.sender, receiver, ratePerSecond, deposit);
        return streamId;
    }

    /**
     * @notice Get the current balance available for receiver to withdraw.
     */
    function balanceOf(bytes32 streamId, address who) public view returns (uint256) {
        Stream memory s = streams[streamId];
        if (s.startTime == 0) revert StreamNotFound(streamId);

        if (who == s.receiver) {
            uint256 elapsed = _activeSeconds(s);
            uint256 earned = elapsed * s.ratePerSecond;
            uint256 maxEarnable = s.deposit; // can't earn more than deposit
            uint256 totalEarned = earned > maxEarnable ? maxEarnable : earned;
            return totalEarned > s.withdrawn ? totalEarned - s.withdrawn : 0;
        }

        if (who == s.sender) {
            // Sender's refundable balance = deposit - earned
            uint256 elapsed = _activeSeconds(s);
            uint256 earned = elapsed * s.ratePerSecond;
            uint256 totalEarned = earned > s.deposit ? s.deposit : earned;
            return s.deposit > totalEarned ? s.deposit - totalEarned : 0;
        }

        return 0;
    }

    /**
     * @notice Receiver withdraws their accrued balance.
     */
    function withdraw(bytes32 streamId) external nonReentrant returns (uint256) {
        Stream storage s = streams[streamId];
        if (s.startTime == 0) revert StreamNotFound(streamId);
        if (msg.sender != s.receiver) revert NotReceiver(streamId);

        uint256 available = balanceOf(streamId, s.receiver);
        if (available == 0) return 0;

        s.withdrawn += available;
        usdc.safeTransfer(s.receiver, available);

        emit StreamWithdrawn(streamId, s.receiver, available);
        return available;
    }

    /**
     * @notice Pause the stream — accrual stops while paused.
     */
    function pauseStream(bytes32 streamId) external returns (bool) {
        Stream storage s = streams[streamId];
        if (s.startTime == 0) revert StreamNotFound(streamId);
        if (msg.sender != s.sender && !authorizedAgents[msg.sender]) revert NotSender(streamId);
        if (s.pausedAt != 0) revert StreamAlreadyPaused(streamId);

        s.pausedAt = block.timestamp;
        emit StreamPaused(streamId);
        return true;
    }

    /**
     * @notice Resume a paused stream.
     */
    function resumeStream(bytes32 streamId) external returns (bool) {
        Stream storage s = streams[streamId];
        if (s.startTime == 0) revert StreamNotFound(streamId);
        if (msg.sender != s.sender && !authorizedAgents[msg.sender]) revert NotSender(streamId);
        if (s.pausedAt == 0) revert StreamNotPaused(streamId);

        s.pausedDuration += block.timestamp - s.pausedAt;
        s.pausedAt = 0;
        emit StreamResumed(streamId);
        return true;
    }

    /**
     * @notice Cancel stream. Receiver gets earned balance; sender gets refund.
     */
    function cancelStream(bytes32 streamId) external nonReentrant returns (bool) {
        Stream storage s = streams[streamId];
        if (s.startTime == 0) revert StreamNotFound(streamId);
        if (s.cancelled) revert StreamAlreadyCancelled(streamId);
        if (msg.sender != s.sender && !authorizedAgents[msg.sender]) revert NotSender(streamId);

        // Pay receiver earned balance
        uint256 receiverBalance = balanceOf(streamId, s.receiver);
        if (receiverBalance > 0) {
            s.withdrawn += receiverBalance;
            usdc.safeTransfer(s.receiver, receiverBalance);
        }

        // Refund remaining to sender
        uint256 refund = s.deposit - s.withdrawn;
        s.cancelled = true;

        if (refund > 0) {
            usdc.safeTransfer(s.sender, refund);
        }

        emit StreamCancelled(streamId, refund);
        return true;
    }

    function _activeSeconds(Stream memory s) internal view returns (uint256) {
        uint256 endTime = s.cancelled ? block.timestamp : block.timestamp;
        uint256 pausedSoFar = s.pausedDuration;
        if (s.pausedAt != 0) {
            pausedSoFar += block.timestamp - s.pausedAt;
        }
        return endTime - s.startTime - pausedSoFar;
    }
}
