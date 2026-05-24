/**
 * setKeeper.ts
 *
 * Grant or revoke keeper role on CPEG NFT contract.
 * The keeper is the address authorized to call sync() and syncBatch().
 * For Chainlink Automation, set the Chainlink forwarder address as keeper.
 *
 * Requires in .env:
 *   CPEG_ADDRESS          (NFT contract)
 *   KEEPER_ADDRESS        (address to grant/revoke)
 *   KEEPER_STATUS         (true = grant, false = revoke)
 *
 * Usage:
 *   cd contracts
 *   pnpm set-keeper
 */

import { ethers } from "hardhat";

async function main() {
  const jpegAddress  = process.env.CPEG_ADDRESS;
  const keeperAddr   = process.env.KEEPER_ADDRESS;
  const keeperStatus = process.env.KEEPER_STATUS !== "false";

  if (!jpegAddress) throw new Error("CPEG_ADDRESS not set in .env");
  if (!keeperAddr)  throw new Error("KEEPER_ADDRESS not set in .env");

  const [deployer] = await ethers.getSigners();
  const jpeg = await ethers.getContractAt("CPEG", jpegAddress);

  console.log("=== Set Keeper ===");
  console.log("Contract:", jpegAddress);
  console.log("Keeper  :", keeperAddr);
  console.log("Status  :", keeperStatus ? "GRANT" : "REVOKE");
  console.log("Signer  :", deployer.address);
  console.log("");

  const tx = await jpeg.setKeeper(keeperAddr, keeperStatus);
  await tx.wait();

  console.log("Tx hash:", tx.hash);
  console.log("Done!");
  console.log("");

  if (keeperStatus) {
    console.log("Next step for Chainlink Automation:");
    console.log("1. Go to https://automation.chain.link");
    console.log("2. Register Upkeep 1 — Custom Logic (periodic safety-net)");
    console.log("3. Register Upkeep 2 — Log Trigger (auto-detect all buyers)");
    console.log("   Log emitter: CPEG token address");
    console.log("   Topic 0: 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    console.log("4. Target contract for both:", jpegAddress);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
