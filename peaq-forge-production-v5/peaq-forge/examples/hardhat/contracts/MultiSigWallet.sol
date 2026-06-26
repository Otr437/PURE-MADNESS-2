// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MultiSigWallet
 * @notice N-of-M multisignature wallet for peaq EVM.
 *         Owners submit transactions; a threshold of confirmations is required to execute.
 * @dev    No external dependencies. Fully self-contained.
 *         - Supports ETH/PEAQ native transfers and arbitrary contract calls.
 *         - Owners can be added/removed via multisig transactions (not directly).
 *         - Reentrancy protected via a simple mutex.
 */
contract MultiSigWallet {

    // ── Events ────────────────────────────────────────────────────────────────
    event Deposit(address indexed sender, uint256 amount, uint256 balance);
    event SubmitTransaction(address indexed owner, uint256 indexed txIndex, address indexed to, uint256 value, bytes data);
    event ConfirmTransaction(address indexed owner, uint256 indexed txIndex);
    event RevokeConfirmation(address indexed owner, uint256 indexed txIndex);
    event ExecuteTransaction(address indexed owner, uint256 indexed txIndex);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event RequirementChanged(uint256 required);

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotOwner();
    error TxDoesNotExist();
    error TxAlreadyExecuted();
    error TxAlreadyConfirmed();
    error TxNotConfirmed();
    error NotEnoughConfirmations();
    error TxFailed();
    error InvalidOwner();
    error DuplicateOwner();
    error InvalidRequirement();
    error OwnersRequired();
    error Reentrancy();

    // ── Storage ───────────────────────────────────────────────────────────────
    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public required;

    struct Transaction {
        address to;
        uint256 value;
        bytes   data;
        bool    executed;
        uint256 numConfirmations;
        string  description;
    }

    Transaction[] public transactions;
    mapping(uint256 => mapping(address => bool)) public isConfirmed;

    bool private _locked;

    // ── Modifiers ─────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    modifier txExists(uint256 txIndex) {
        if (txIndex >= transactions.length) revert TxDoesNotExist();
        _;
    }

    modifier notExecuted(uint256 txIndex) {
        if (transactions[txIndex].executed) revert TxAlreadyExecuted();
        _;
    }

    modifier notConfirmed(uint256 txIndex) {
        if (isConfirmed[txIndex][msg.sender]) revert TxAlreadyConfirmed();
        _;
    }

    modifier noReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    /**
     * @param _owners   Array of initial owner addresses.
     * @param _required Number of confirmations required to execute (must be ≤ owners.length).
     */
    constructor(address[] memory _owners, uint256 _required) {
        if (_owners.length == 0) revert OwnersRequired();
        if (_required == 0 || _required > _owners.length) revert InvalidRequirement();

        for (uint256 i = 0; i < _owners.length; i++) {
            address owner = _owners[i];
            if (owner == address(0)) revert InvalidOwner();
            if (isOwner[owner])      revert DuplicateOwner();
            isOwner[owner] = true;
            owners.push(owner);
        }
        required = _required;
    }

    // ── Receive ETH/PEAQ ──────────────────────────────────────────────────────
    receive() external payable {
        emit Deposit(msg.sender, msg.value, address(this).balance);
    }

    fallback() external payable {
        emit Deposit(msg.sender, msg.value, address(this).balance);
    }

    // ── Transaction submission ────────────────────────────────────────────────
    /**
     * @notice Submit a new transaction for multisig approval.
     * @param to          Target address.
     * @param value       PEAQ value to send (in wei).
     * @param data        Calldata for contract calls. Empty bytes for plain transfers.
     * @param description Human-readable description of the transaction.
     */
    function submitTransaction(
        address to,
        uint256 value,
        bytes   calldata data,
        string  calldata description
    ) external onlyOwner returns (uint256 txIndex) {
        txIndex = transactions.length;
        transactions.push(Transaction({
            to:               to,
            value:            value,
            data:             data,
            executed:         false,
            numConfirmations: 0,
            description:      description
        }));
        emit SubmitTransaction(msg.sender, txIndex, to, value, data);
    }

    // ── Confirmation ──────────────────────────────────────────────────────────
    /**
     * @notice Confirm a pending transaction.
     */
    function confirmTransaction(uint256 txIndex)
        external
        onlyOwner
        txExists(txIndex)
        notExecuted(txIndex)
        notConfirmed(txIndex)
    {
        Transaction storage transaction = transactions[txIndex];
        transaction.numConfirmations++;
        isConfirmed[txIndex][msg.sender] = true;
        emit ConfirmTransaction(msg.sender, txIndex);
    }

    /**
     * @notice Execute a transaction that has reached the required confirmations.
     */
    function executeTransaction(uint256 txIndex)
        external
        onlyOwner
        txExists(txIndex)
        notExecuted(txIndex)
        noReentrant
    {
        Transaction storage transaction = transactions[txIndex];
        if (transaction.numConfirmations < required) revert NotEnoughConfirmations();

        transaction.executed = true;
        (bool success, ) = transaction.to.call{ value: transaction.value }(transaction.data);
        if (!success) revert TxFailed();

        emit ExecuteTransaction(msg.sender, txIndex);
    }

    /**
     * @notice Revoke your confirmation for a pending transaction.
     */
    function revokeConfirmation(uint256 txIndex)
        external
        onlyOwner
        txExists(txIndex)
        notExecuted(txIndex)
    {
        if (!isConfirmed[txIndex][msg.sender]) revert TxNotConfirmed();
        Transaction storage transaction = transactions[txIndex];
        transaction.numConfirmations--;
        isConfirmed[txIndex][msg.sender] = false;
        emit RevokeConfirmation(msg.sender, txIndex);
    }

    // ── View functions ────────────────────────────────────────────────────────
    function getOwners() external view returns (address[] memory) { return owners; }

    function getTransactionCount() external view returns (uint256) { return transactions.length; }

    function getTransaction(uint256 txIndex)
        external
        view
        txExists(txIndex)
        returns (
            address to,
            uint256 value,
            bytes   memory data,
            bool    executed,
            uint256 numConfirmations,
            string  memory description
        )
    {
        Transaction storage t = transactions[txIndex];
        return (t.to, t.value, t.data, t.executed, t.numConfirmations, t.description);
    }

    function getBalance() external view returns (uint256) { return address(this).balance; }

    function getPendingTransactions() external view returns (uint256[] memory) {
        uint256 count;
        for (uint256 i = 0; i < transactions.length; i++) {
            if (!transactions[i].executed) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx;
        for (uint256 i = 0; i < transactions.length; i++) {
            if (!transactions[i].executed) result[idx++] = i;
        }
        return result;
    }
}
