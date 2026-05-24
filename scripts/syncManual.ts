/**
 * syncManual.ts
 *
 * Manually runs the full sync test flow on Base Sepolia.
 * Simulates: buy -> mint, top-up -> upgrade, sell -> downgrade, sell all -> burn.
 *
 * Requires in .env:
 *   CPEG_TOKEN_ADDRESS
 *   CPEG_ADDRESS
 *
 * Usage:
 *   cd contracts
 *   pnpm sync
 */

import { ethers } from "hardhat";

const TIER_NAMES = ["None", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic"];

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function printState(jpeg: any, cpeg: any, wallet: string) {
  // Small delay to allow public RPC to reflect latest block
  await sleep(2000);
  const tier = await jpeg.tierOf(wallet);
  const balance = await cpeg.balanceOf(wallet);
  const rewards = await jpeg.pendingRewards(wallet);
  console.log(`   Balance : ${Number(ethers.formatEther(balance)).toLocaleString()} CPEG`);
  console.log(`   Tier    : ${TIER_NAMES[Number(tier)]} (${tier})`);
  console.log(`   Rewards : ${ethers.formatEther(rewards)} ETH pending`);
}

async function main() {
  const cpegAddress = process.env.CPEG_TOKEN_ADDRESS;
  const jpegAddress = process.env.CPEG_ADDRESS;
  if (!cpegAddress || !jpegAddress) {
    throw new Error("Set CPEG_TOKEN_ADDRESS and CPEG_ADDRESS in .env");
  }

  const [deployer] = await ethers.getSigners();
  const cpeg = await ethers.getContractAt("MockCPEG", cpegAddress);
  const jpeg = await ethers.getContractAt("CPEG", jpegAddress);

  console.log("=== CPEG — Manual Sync Test ===");
  console.log("Keeper :", deployer.address);
  console.log("Network: Base Sepolia");
  console.log("");

  // ---- TEST 1: Sync current balance -> should mint at correct tier ----
  console.log("TEST 1: Sync current CPEG balance -> expect correct tier");
  let tx = await (jpeg as any).sync(deployer.address, { gasLimit: 300000 });
  await tx.wait();
  await printState(jpeg, cpeg, deployer.address);
  const t1 = await jpeg.tierOf(deployer.address);
  console.log(`   Result  : ${Number(t1) > 0 ? "PASS - NFT minted" : "No balance above threshold"}`);
  console.log("");

  // ---- TEST 2: Deposit rewards ----
  console.log("TEST 2: Deposit 0.001 ETH rewards");
  tx = await (jpeg as any).depositRewards({ value: ethers.parseEther("0.001"), gasLimit: 100000 });
  await tx.wait();
  await printState(jpeg, cpeg, deployer.address);
  const r2 = await jpeg.pendingRewards(deployer.address);
  console.log(`   Result  : ${r2 > 0n ? "PASS - rewards accrued" : "FAIL"}`);
  console.log("");

  // ---- TEST 3: Downgrade by transferring tokens away ----
  console.log("TEST 3: Transfer CPEG down to Common (15M) -> expect downgrade");
  const currentBal = await cpeg.balanceOf(deployer.address);
  const keep = ethers.parseEther("15000000"); // keep 15M -> Common tier
  if (currentBal > keep) {
    tx = await cpeg.transfer("0x000000000000000000000000000000000000dEaD", currentBal - keep, { gasLimit: 100000 });
    await tx.wait();
  }
  tx = await (jpeg as any).sync(deployer.address, { gasLimit: 300000 });
  await tx.wait();
  await printState(jpeg, cpeg, deployer.address);
  const t3 = await jpeg.tierOf(deployer.address);
  console.log(`   Result  : ${Number(t3) === 1 ? "PASS - downgraded to Common" : "FAIL (tier=" + t3 + ")"}`);
  console.log("");

  // ---- TEST 4: Rewards preserved through tier change ----
  console.log("TEST 4: Check rewards survived downgrade");
  const r4 = await jpeg.pendingRewards(deployer.address);
  console.log(`   Pending : ${ethers.formatEther(r4)} ETH`);
  console.log(`   Result  : ${r4 > 0n ? "PASS - rewards intact" : "FAIL"}`);
  console.log("");

  // ---- TEST 5: No-op sync ----
  console.log("TEST 5: Sync with no change -> expect no-op (no Synced event)");
  tx = await (jpeg as any).sync(deployer.address, { gasLimit: 300000 });
  const receipt = await tx.wait();
  const events = receipt.logs.filter((l: any) => l.fragment?.name === "Synced");
  console.log(`   Gas used : ${receipt.gasUsed.toString()}`);
  console.log(`   Result   : ${events.length === 0 ? "PASS - no-op" : "FAIL"}`);
  console.log("");

  // ---- TEST 6: Sell all -> burn ----
  console.log("TEST 6: Transfer all CPEG away -> expect burn (tier 0)");
  const allBal = await cpeg.balanceOf(deployer.address);
  tx = await cpeg.transfer("0x000000000000000000000000000000000000dEaD", allBal, { gasLimit: 100000 });
  await tx.wait();
  tx = await (jpeg as any).sync(deployer.address, { gasLimit: 300000 });
  await tx.wait();
  await printState(jpeg, cpeg, deployer.address);
  const t6 = await jpeg.tierOf(deployer.address);
  console.log(`   Result  : ${Number(t6) === 0 ? "PASS - NFT burned" : "FAIL"}`);
  console.log("");

  console.log("=== All tests complete! ===");
  console.log("");
  console.log("Contract links:");
  console.log("  MockCPEG     : https://sepolia.basescan.org/address/" + cpegAddress + "#code");
  console.log("  CPEG : https://sepolia.basescan.org/address/" + jpegAddress + "#code");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
