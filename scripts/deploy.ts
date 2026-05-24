/**
 * deploy.ts
 *
 * Deploys CPEG NFT contract to Base mainnet with a real CPEG token address.
 * Requires CPEG_TOKEN_ADDRESS in .env.
 *
 * Usage:
 *   cd contracts
 *   pnpm deploy:mainnet
 */

import { ethers } from "hardhat";

async function main() {
  const cpegAddress = process.env.CPEG_TOKEN_ADDRESS;
  if (!cpegAddress) throw new Error("CPEG_TOKEN_ADDRESS not set in .env");

  const nftUri = process.env.NFT_BASE_URI || "https://cpeg.io/api/token/{id}.json";

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=== CPEG — Mainnet Deploy (Base) ===");
  console.log("Deployer  :", deployer.address);
  console.log("Balance   :", ethers.formatEther(balance), "ETH");
  console.log("CPEG Token:", cpegAddress);
  console.log("NFT URI   :", nftUri);
  console.log("");

  console.log("Deploying CPEG...");
  const CPEG = await ethers.getContractFactory("CPEG");
  const jpeg = await CPEG.deploy(cpegAddress, nftUri);
  await jpeg.waitForDeployment();
  const jpegAddress = await jpeg.getAddress();

  console.log("CPEG deployed:", jpegAddress);
  console.log("");
  console.log("=== Done! ===");
  console.log("");
  console.log("Next steps:");
  console.log("1. Verify contract:");
  console.log(`   npx hardhat verify --network base ${jpegAddress} "${cpegAddress}" "${nftUri}"`);
  console.log("2. Set Chainlink keeper:");
  console.log(`   CPEG_ADDRESS=${jpegAddress} pnpm set-keeper`);
  console.log("3. Register Chainlink Automation upkeep at:");
  console.log("   https://automation.chain.link");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
