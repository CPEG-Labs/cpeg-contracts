/**
 * checkUpkeep.ts
 *
 * Simulates what Chainlink Automation nodes do:
 *   1. Register holders on the watchlist
 *   2. Call checkUpkeep() to find stale tiers
 *   3. Call performUpkeep() to sync them
 *
 * Requires in .env:
 *   CPEG_TOKEN_ADDRESS
 *   CPEG_ADDRESS
 *
 * Usage:
 *   cd contracts
 *   npx hardhat run scripts/checkUpkeep.ts --network baseSepolia
 */

import { ethers } from "hardhat";

const TIER_NAMES = ["None", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic"];

async function main() {
  const cpegAddress = process.env.CPEG_TOKEN_ADDRESS;
  const jpegAddress = process.env.CPEG_ADDRESS;
  if (!cpegAddress || !jpegAddress) throw new Error("Set contract addresses in .env");

  const [deployer] = await ethers.getSigners();
  const cpeg = await ethers.getContractAt("MockCPEG", cpegAddress);
  const jpeg = await ethers.getContractAt("CPEG", jpegAddress);

  console.log("=== Chainlink Automation Simulation ===");
  console.log("CPEG :", jpegAddress);
  console.log("Deployer     :", deployer.address);
  console.log("");

  // ---- Step 1: Mint some CPEG and register deployer on watchlist ----
  console.log("1. Minting 200M CPEG and registering on watchlist...");
  await (cpeg as any).mint(deployer.address, ethers.parseEther("200000000"), { gasLimit: 100000 });
  await (jpeg as any).registerHolder(deployer.address, { gasLimit: 100000 });
  const wl = await jpeg.watchlistLength();
  console.log("   Watchlist size:", wl.toString());
  console.log("");

  // ---- Step 2: checkUpkeep - Chainlink node calls this off-chain ----
  console.log("2. checkUpkeep() - Chainlink node checks for stale tiers...");
  const checkData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [0, 50]);
  const [needed, performData] = await jpeg.checkUpkeep(checkData);
  console.log("   upkeepNeeded:", needed);

  if (!needed) {
    console.log("   No stale holders. Done.");
    return;
  }

  const [stale] = ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], performData);
  console.log("   Stale holders:", stale.length);
  for (const addr of stale) {
    const bal = await cpeg.balanceOf(addr);
    const tier = await jpeg.tierOf(addr);
    const expectedTier = await jpeg.getTierForBalance(bal);
    console.log(`     ${addr} — current tier: ${TIER_NAMES[Number(tier)]}, expected: ${TIER_NAMES[Number(expectedTier)]}`);
  }
  console.log("");

  // ---- Step 3: performUpkeep - Chainlink node executes this on-chain ----
  console.log("3. performUpkeep() - Chainlink node triggers sync...");
  const tx = await (jpeg as any).performUpkeep(performData, { gasLimit: 500000 });
  const receipt = await tx.wait();
  console.log("   Tx hash    :", tx.hash);
  console.log("   Gas used   :", receipt.gasUsed.toString());

  const synced = receipt.logs.filter((l: any) => l.fragment?.name === "Synced");
  for (const e of synced) {
    const { holder, oldTier, newTier } = e.args;
    console.log(`   Synced: ${holder} | ${TIER_NAMES[Number(oldTier)]} → ${TIER_NAMES[Number(newTier)]}`);
  }
  console.log("");

  // ---- Step 4: Re-run checkUpkeep - should return false now ----
  console.log("4. checkUpkeep() again - should return false (no more stale)...");
  const [neededAfter] = await jpeg.checkUpkeep(checkData);
  console.log("   upkeepNeeded:", neededAfter, neededAfter === false ? "PASS" : "FAIL");

  const tier = await jpeg.tierOf(deployer.address);
  console.log("   Deployer tier:", TIER_NAMES[Number(tier)]);
  console.log("");

  console.log("=== Simulation complete! ===");
  console.log("");
  console.log("To register as a Chainlink Automation upkeep:");
  console.log("1. Go to https://automation.chain.link");
  console.log("2. Select Base Sepolia network");
  console.log("3. Click 'Register New Upkeep' > 'Custom Logic'");
  console.log("4. Target contract:", jpegAddress);
  console.log("5. checkData (paste this):");
  console.log("  ", checkData);
  console.log("6. Fund with test LINK from https://faucets.chain.link");
  console.log("7. After registration, copy the Forwarder address");
  console.log("8. Run: KEEPER_ADDRESS=<forwarder> npx hardhat run scripts/setKeeper.ts --network baseSepolia");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
