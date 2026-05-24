/**
 * deployMock.ts
 *
 * Deploys MockCPEG + CPEG (NFT contract) to Base Sepolia for end-to-end testing.
 * Use this script when you don't have a real CPEG token yet.
 *
 * Usage:
 *   cd contracts
 *   pnpm deploy:mock
 */

import { ethers } from "hardhat";

const NFT_URI = "https://cpeg.io/api/token/{id}.json";

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=== CPEG — Mock Deploy (Base Sepolia) ===");
  console.log("Deployer :", deployer.address);
  console.log("Balance  :", ethers.formatEther(balance), "ETH");
  console.log("");

  // 1. Deploy MockCPEG
  console.log("1. Deploying MockCPEG...");
  const MockCPEG = await ethers.getContractFactory("MockCPEG");
  const cpeg = await MockCPEG.deploy();
  await cpeg.waitForDeployment();
  const cpegAddress = await cpeg.getAddress();
  console.log("   MockCPEG:", cpegAddress);

  // 2. Deploy CPEG NFT contract
  console.log("2. Deploying CPEG...");
  const CPEG = await ethers.getContractFactory("CPEG");
  const jpeg = await CPEG.deploy(cpegAddress, NFT_URI);
  await jpeg.waitForDeployment();
  const jpegAddress = await jpeg.getAddress();
  console.log("   CPEG:", jpegAddress);

  // 3. Set deployer as keeper for manual testing
  console.log("3. Setting deployer as keeper...");
  await jpeg.setKeeper(deployer.address, true);
  console.log("   Keeper set:", deployer.address);

  // 4. Distribute some test CPEG to deployer wallet
  console.log("4. Minting test CPEG to deployer...");
  const testAmount = ethers.parseEther("500000000"); // 500M - Epic tier
  await (cpeg as any).mint(deployer.address, testAmount);
  console.log("   Minted 500M mCPEG");

  console.log("");
  console.log("=== Deploy complete! ===");
  console.log("");
  console.log("Add these to your .env:");
  console.log(`CPEG_TOKEN_ADDRESS=${cpegAddress}`);
  console.log(`CPEG_ADDRESS=${jpegAddress}`);
  console.log("");
  console.log("Verify on Basescan:");
  console.log(`npx hardhat verify --network baseSepolia ${cpegAddress}`);
  console.log(`npx hardhat verify --network baseSepolia ${jpegAddress} "${cpegAddress}" "${NFT_URI}"`);
  console.log("");
  console.log("Next: run sync test");
  console.log("pnpm sync");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
