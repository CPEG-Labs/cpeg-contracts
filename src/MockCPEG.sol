// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockCPEG
 * @notice Test-only ERC-20 token that mimics CPEG.
 *         Allows free minting so we can simulate any balance scenario.
 *         Do NOT deploy to mainnet.
 */
contract MockCPEG is ERC20 {
    constructor() ERC20("Mock CPEG", "mCPEG") {
        _mint(msg.sender, 10_000_000_000 * 1e18); // 10B initial supply to deployer
    }

    /**
     * @notice Mint any amount to any address. Only for testing.
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
