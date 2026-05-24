// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title CPEG
 * @notice Dynamic soulbound ERC-1155 NFT tied to CPEG token holdings.
 *
 * Compatible with TWO Chainlink Automation upkeep types:
 *
 *   1. LOG TRIGGER upkeep (recommended — detects ALL buyers automatically)
 *      - Listen to: CPEG token Transfer(address,address,uint256) events
 *      - checkLog() validates the event and returns the buyer address
 *      - performUpkeep() auto-registers buyer + syncs tier
 *      - No manual registration needed — every CPEG buy is detected instantly
 *
 *   2. CUSTOM LOGIC upkeep (periodic safety-net for existing holders)
 *      - checkUpkeep() scans the watchlist for stale tiers
 *      - performUpkeep() batch-syncs them
 *      - Catches any tier drift not caught by the log trigger
 *
 * Register BOTH upkeeps at automation.chain.link for full coverage.
 *
 * Tiers (determined by CPEG balance):
 *   1 = Common      10M  -  50M  CPEG   1.0x rewards
 *   2 = Uncommon    50M  - 100M  CPEG   1.5x rewards
 *   3 = Rare       100M  - 500M  CPEG   2.0x rewards
 *   4 = Epic       500M  -   1B  CPEG   2.5x rewards
 *   5 = Legendary    1B  -   2B  CPEG   4.0x rewards
 *   6 = Mythic       2B+         CPEG   6.0x rewards
 */
contract CPEG is ERC1155, Ownable, ReentrancyGuard {

    // ============================================================
    // CHAINLINK LOG TRIGGER INTERFACE (inline — no package needed)
    // ============================================================

    struct Log {
        uint256 index;
        uint256 timestamp;
        bytes32 txHash;
        uint256 blockNumber;
        bytes32 blockHash;
        address source;
        bytes32[] topics;
        bytes data;
    }

    /// Transfer(address indexed from, address indexed to, uint256 value)
    bytes32 private constant TRANSFER_SIG =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    // ============================================================
    // CONSTANTS
    // ============================================================

    uint256 public constant COMMON    = 1;
    uint256 public constant UNCOMMON  = 2;
    uint256 public constant RARE      = 3;
    uint256 public constant EPIC      = 4;
    uint256 public constant LEGENDARY = 5;
    uint256 public constant MYTHIC    = 6;

    uint256 public constant MAX_BATCH = 50;

    uint256[6] public TIER_THRESHOLDS = [
        10_000_000    * 1e18,
        50_000_000    * 1e18,
        100_000_000   * 1e18,
        500_000_000   * 1e18,
        1_000_000_000 * 1e18,
        2_000_000_000 * 1e18
    ];

    uint256[6] public TIER_POINTS = [100, 150, 200, 250, 400, 600];

    // ============================================================
    // STATE
    // ============================================================

    IERC20 public immutable cpegToken;

    mapping(address => bool) public isKeeper;
    mapping(address => uint256) public currentTier;

    // Masterchef-style reward tracking
    uint256 public totalPoints;
    uint256 public accRewardPerPoint;
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public claimableRewards;

    // Watchlist
    address[] public watchlist;
    mapping(address => uint256) private _watchlistIndex; // 1-indexed
    mapping(address => bool)    public  isRegistered;

    // ============================================================
    // EVENTS
    // ============================================================

    event Synced(address indexed holder, uint256 oldTier, uint256 newTier);
    event RewardsDeposited(uint256 amount);
    event RewardsClaimed(address indexed holder, uint256 amount);
    event KeeperSet(address indexed keeper, bool status);
    event HolderRegistered(address indexed holder);
    event HolderUnregistered(address indexed holder);

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    constructor(address _cpegToken, string memory _uri)
        ERC1155(_uri)
        Ownable(msg.sender)
    {
        require(_cpegToken != address(0), "Invalid token address");
        cpegToken = IERC20(_cpegToken);
    }

    // ============================================================
    // MODIFIERS
    // ============================================================

    modifier onlyKeeper() {
        require(isKeeper[msg.sender] || msg.sender == owner(), "Not a keeper");
        _;
    }

    // ============================================================
    // VIEW FUNCTIONS
    // ============================================================

    function tierOf(address holder) external view returns (uint256) {
        return currentTier[holder];
    }

    function getTierForBalance(uint256 balance) public view returns (uint256) {
        if (balance >= TIER_THRESHOLDS[5]) return MYTHIC;
        if (balance >= TIER_THRESHOLDS[4]) return LEGENDARY;
        if (balance >= TIER_THRESHOLDS[3]) return EPIC;
        if (balance >= TIER_THRESHOLDS[2]) return RARE;
        if (balance >= TIER_THRESHOLDS[1]) return UNCOMMON;
        if (balance >= TIER_THRESHOLDS[0]) return COMMON;
        return 0;
    }

    function pendingRewards(address holder) external view returns (uint256) {
        uint256 tier = currentTier[holder];
        uint256 base = claimableRewards[holder];
        if (tier == 0) return base;
        uint256 points  = TIER_POINTS[tier - 1];
        uint256 earned  = (points * accRewardPerPoint) / 1e18;
        uint256 pending = earned > rewardDebt[holder] ? earned - rewardDebt[holder] : 0;
        return base + pending;
    }

    function watchlistLength() external view returns (uint256) {
        return watchlist.length;
    }

    // ============================================================
    // CHAINLINK LOG TRIGGER — auto-detect ALL CPEG buyers
    // ============================================================

    /**
     * @notice Called off-chain by Chainlink when a CPEG Transfer event fires.
     *         Extracts the recipient (buyer) and returns them for syncing.
     *
     * Register this as a LOG TRIGGER upkeep:
     *   - Log address  : CPEG token contract address
     *   - Topic 0      : 0xddf252ad... (Transfer event sig)
     *
     * @param log The emitted Transfer log decoded by Chainlink.
     * @return upkeepNeeded True if the recipient's tier needs updating.
     * @return performData  ABI-encoded address[] with the recipient.
     */
    function checkLog(Log calldata log, bytes memory /*checkData*/)
        external
        view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        // Validate: must be from CPEG token and be a Transfer event
        if (log.source != address(cpegToken)) return (false, "");
        if (log.topics.length < 3) return (false, "");
        if (log.topics[0] != TRANSFER_SIG) return (false, "");

        // Extract `to` (recipient) from topics[2]
        address recipient = address(uint160(uint256(log.topics[2])));

        // Zero address = mint event to protocol, skip
        if (recipient == address(0)) return (false, "");

        uint256 balance    = cpegToken.balanceOf(recipient);
        uint256 newTier    = getTierForBalance(balance);
        uint256 currentTierVal = currentTier[recipient];

        // Only upkeep if tier needs to change
        if (newTier == currentTierVal) return (false, "");

        address[] memory targets = new address[](1);
        targets[0] = recipient;
        return (true, abi.encode(targets));
    }

    // ============================================================
    // CHAINLINK CUSTOM LOGIC — periodic safety-net for watchlist
    // ============================================================

    /**
     * @notice Scans watchlist for holders with stale tiers.
     *         Use with a CUSTOM LOGIC upkeep as a periodic safety-net.
     *
     * @param checkData ABI-encoded (uint256 startIndex, uint256 batchSize).
     *                  Pass abi.encode(0, 50) to scan from the beginning.
     */
    function checkUpkeep(bytes calldata checkData)
        external
        view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 startIndex;
        uint256 batchSize = MAX_BATCH;

        if (checkData.length > 0) {
            (startIndex, batchSize) = abi.decode(checkData, (uint256, uint256));
            if (batchSize == 0 || batchSize > MAX_BATCH) batchSize = MAX_BATCH;
        }

        uint256 total = watchlist.length;
        uint256 end   = startIndex + batchSize;
        if (end > total) end = total;

        address[] memory stale = new address[](end - startIndex);
        uint256 count = 0;

        for (uint256 i = startIndex; i < end; i++) {
            address holder  = watchlist[i];
            uint256 balance = cpegToken.balanceOf(holder);
            uint256 newTier = getTierForBalance(balance);
            if (newTier != currentTier[holder]) {
                stale[count] = holder;
                count++;
            }
        }

        if (count == 0) return (false, "");

        address[] memory result = new address[](count);
        for (uint256 i = 0; i < count; i++) result[i] = stale[i];

        return (true, abi.encode(result));
    }

    // ============================================================
    // performUpkeep — shared by BOTH upkeep types
    // ============================================================

    /**
     * @notice Called on-chain by Chainlink (both Log Trigger and Custom Logic).
     *         Receives address[] encoded as performData.
     *         Auto-registers any unregistered holders, then syncs their tiers.
     *
     * @param performData ABI-encoded address[] from checkLog or checkUpkeep.
     */
    function performUpkeep(bytes calldata performData) external {
        address[] memory holders = abi.decode(performData, (address[]));
        require(holders.length > 0 && holders.length <= MAX_BATCH, "Invalid batch");

        for (uint256 i = 0; i < holders.length; i++) {
            address holder = holders[i];
            if (holder == address(0)) continue;

            // Auto-register new holders discovered via Log Trigger
            _registerHolder(holder);

            _sync(holder);
        }
    }

    // ============================================================
    // WATCHLIST MANAGEMENT
    // ============================================================

    function registerHolder(address holder) external {
        _registerHolder(holder);
    }

    function registerHolderBatch(address[] calldata holders) external {
        for (uint256 i = 0; i < holders.length; i++) {
            _registerHolder(holders[i]);
        }
    }

    function unregisterHolder(address holder) external onlyKeeper {
        _unregisterHolder(holder);
    }

    function _registerHolder(address holder) internal {
        if (isRegistered[holder]) return;
        isRegistered[holder] = true;
        _watchlistIndex[holder] = watchlist.length + 1;
        watchlist.push(holder);
        emit HolderRegistered(holder);
    }

    function _unregisterHolder(address holder) internal {
        if (!isRegistered[holder]) return;

        uint256 idx  = _watchlistIndex[holder] - 1;
        uint256 last = watchlist.length - 1;

        if (idx != last) {
            address moved = watchlist[last];
            watchlist[idx] = moved;
            _watchlistIndex[moved] = idx + 1;
        }

        watchlist.pop();
        delete _watchlistIndex[holder];
        delete isRegistered[holder];

        emit HolderUnregistered(holder);
    }

    // ============================================================
    // MANUAL SYNC (keeper fallback)
    // ============================================================

    function sync(address holder) external onlyKeeper {
        _registerHolder(holder);
        _sync(holder);
    }

    function syncBatch(address[] calldata holders) external onlyKeeper {
        require(holders.length <= MAX_BATCH, "Max 50 per batch");
        for (uint256 i = 0; i < holders.length; i++) {
            _registerHolder(holders[i]);
            _sync(holders[i]);
        }
    }

    // ============================================================
    // REWARDS
    // ============================================================

    function depositRewards() external payable {
        require(msg.value > 0, "Zero deposit");
        if (totalPoints > 0) {
            accRewardPerPoint += (msg.value * 1e18) / totalPoints;
        }
        emit RewardsDeposited(msg.value);
    }

    function claim() external nonReentrant {
        _harvest(msg.sender);
        uint256 amount = claimableRewards[msg.sender];
        require(amount > 0, "Nothing to claim");
        claimableRewards[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
        emit RewardsClaimed(msg.sender, amount);
    }

    // ============================================================
    // INTERNAL
    // ============================================================

    function _sync(address holder) internal {
        uint256 balance = cpegToken.balanceOf(holder);
        uint256 newTier = getTierForBalance(balance);
        uint256 oldTier = currentTier[holder];

        if (newTier == oldTier) return;

        _harvest(holder);

        if (oldTier > 0) {
            _burn(holder, oldTier, 1);
            totalPoints -= TIER_POINTS[oldTier - 1];
        }

        if (newTier > 0) {
            _mint(holder, newTier, 1, "");
            totalPoints += TIER_POINTS[newTier - 1];
        }

        currentTier[holder] = newTier;

        rewardDebt[holder] = newTier > 0
            ? (TIER_POINTS[newTier - 1] * accRewardPerPoint) / 1e18
            : 0;

        emit Synced(holder, oldTier, newTier);
    }

    function _harvest(address holder) internal {
        uint256 tier = currentTier[holder];
        if (tier == 0) return;
        uint256 points = TIER_POINTS[tier - 1];
        uint256 earned = (points * accRewardPerPoint) / 1e18;
        if (earned > rewardDebt[holder]) {
            claimableRewards[holder] += earned - rewardDebt[holder];
        }
        rewardDebt[holder] = earned;
    }

    // ============================================================
    // SOULBOUND
    // ============================================================

    function safeTransferFrom(
        address from, address to, uint256 id, uint256 amount, bytes memory data
    ) public override {
        require(from == address(0) || to == address(0), "Soulbound: non-transferable");
        super.safeTransferFrom(from, to, id, amount, data);
    }

    function safeBatchTransferFrom(
        address from, address to, uint256[] memory ids, uint256[] memory amounts, bytes memory data
    ) public override {
        require(from == address(0) || to == address(0), "Soulbound: non-transferable");
        super.safeBatchTransferFrom(from, to, ids, amounts, data);
    }

    function setApprovalForAll(address, bool) public pure override {
        revert("Soulbound: approvals disabled");
    }

    // ============================================================
    // ADMIN
    // ============================================================

    function setKeeper(address keeper, bool status) external onlyOwner {
        isKeeper[keeper] = status;
        emit KeeperSet(keeper, status);
    }

    function setURI(string memory newURI) external onlyOwner {
        _setURI(newURI);
    }

    receive() external payable {
        if (totalPoints > 0) {
            accRewardPerPoint += (msg.value * 1e18) / totalPoints;
        }
        emit RewardsDeposited(msg.value);
    }
}
