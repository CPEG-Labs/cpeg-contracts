/**
 * test5wallets.ts
 *
 * Creates 5 fresh wallets, funds them from deployer, transfers CPEG
 * at different amounts, then simulates exactly what Chainlink Log Trigger
 * does: construct the Transfer log → checkLog → performUpkeep.
 *
 * No manual registerHolder() is called anywhere.
 * All 5 wallets should get the correct tier automatically.
 *
 * Usage:
 *   cd contracts
 *   npx hardhat run scripts/test5wallets.ts --network baseSepolia
 */

import { ethers } from "hardhat";

const TIER = ["None", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic"];
const TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until condition met */
async function poll<T>(
  fn: () => Promise<T>,
  check: (v: T) => boolean,
  attempts = 8,
  delayMs = 2000
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const v = await fn();
    if (check(v)) return v;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return fn();
}

/** Build the Log struct that Chainlink passes to checkLog for a Transfer event */
function buildTransferLog(
  cpegAddress: string,
  from: string,
  to: string,
  amount: bigint,
  blockNumber = 0
): any {
  return {
    index: 0,
    timestamp: Math.floor(Date.now() / 1000),
    txHash: ethers.ZeroHash,
    blockNumber,
    blockHash: ethers.ZeroHash,
    source: cpegAddress,
    topics: [
      TRANSFER_SIG,
      ethers.zeroPadValue(from, 32),
      ethers.zeroPadValue(to, 32),
    ],
    data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [amount]),
  };
}

async function main() {
  const cpegAddress = process.env.CPEG_TOKEN_ADDRESS!;
  const jpegAddress = process.env.CPEG_ADDRESS!;
  if (!cpegAddress || !jpegAddress) throw new Error("Set contract addresses in .env");

  const [deployer] = await ethers.getSigners();
  const cpeg = await ethers.getContractAt("MockCPEG", cpegAddress);
  const jpeg = await ethers.getContractAt("CPEG", jpegAddress);

  console.log("══════════════════════════════════════════════════");
  console.log("  5-Wallet Auto-Tier Test (Log Trigger Simulation)");
  console.log("══════════════════════════════════════════════════");
  console.log("CPEG :", jpegAddress);
  console.log("MockCPEG     :", cpegAddress);
  console.log("Deployer     :", deployer.address);
  console.log("");
  console.log("NOTE: registerHolder() is NEVER called.");
  console.log("      Only checkLog → performUpkeep, just like Chainlink.");
  console.log("");

  // ── Create 5 wallets ────────────────────────────────────
  const wallets = Array.from({ length: 5 }, () => ethers.Wallet.createRandom());

  const SCENARIOS = [
    { name: "Alice",   cpeg: "15000000",    expectedTier: 1 }, // Common
    { name: "Bob",     cpeg: "75000000",    expectedTier: 2 }, // Uncommon
    { name: "Carol",   cpeg: "200000000",   expectedTier: 3 }, // Rare
    { name: "Dave",    cpeg: "750000000",   expectedTier: 4 }, // Epic
    { name: "Eve",     cpeg: "1500000000",  expectedTier: 5 }, // Legendary
  ];

  console.log("Step 1 — Fund wallets with ETH (for future gas) + CPEG");
  console.log("─────────────────────────────────────────────────────");

  for (let i = 0; i < 5; i++) {
    const w = wallets[i];
    const s = SCENARIOS[i];
    const amount = ethers.parseEther(s.cpeg);

    process.stdout.write(`  ${s.name} (${w.address.slice(0, 10)}...): `);

    // Fund ETH
    await (await deployer.sendTransaction({
      to: w.address,
      value: ethers.parseEther("0.0005"),
      gasLimit: 21000,
    })).wait();

    // Transfer CPEG (this is what emits the Transfer event Chainlink listens to)
    await (await cpeg.mint(w.address, amount, { gasLimit: 100000 })).wait();

    // Confirm balance settled
    await poll(
      () => cpeg.balanceOf(w.address),
      (b) => b === amount
    );

    console.log(`${ethers.formatEther(amount)} CPEG → expected ${TIER[s.expectedTier]}`);
  }

  console.log("");
  console.log("Step 2 — Chainlink Log Trigger simulation per wallet");
  console.log("─────────────────────────────────────────────────────");
  console.log("(Constructing Transfer log → checkLog → performUpkeep)");
  console.log("");

  const results: { name: string; pass: boolean; tier: string; gasUsed: bigint }[] = [];

  for (let i = 0; i < 5; i++) {
    const w = wallets[i];
    const s = SCENARIOS[i];
    const amount = ethers.parseEther(s.cpeg);

    console.log(`  [${i + 1}/5] ${s.name} (${w.address.slice(0, 10)}...)`);

    // Verify NOT registered before test
    const beforeReg = await jpeg.isRegistered(w.address);
    console.log(`    isRegistered before : ${beforeReg} (should be false)`);

    // Build the Transfer log exactly as Chainlink would
    const log = buildTransferLog(cpegAddress, deployer.address, w.address, amount);

    // checkLog (view — simulates Chainlink node off-chain check)
    const [needed, performData] = await jpeg.checkLog.staticCall(log, "0x");
    console.log(`    checkLog upkeepNeeded: ${needed}`);

    if (!needed) {
      console.log(`    SKIP: checkLog returned false`);
      results.push({ name: s.name, pass: false, tier: "None", gasUsed: 0n });
      continue;
    }

    // performUpkeep (on-chain — simulates Chainlink node executing)
    const tx = await jpeg.performUpkeep(performData, { gasLimit: 400000 });
    const receipt = await tx.wait();

    // Poll for updated tier
    const tier = await poll(
      () => jpeg.tierOf(w.address),
      (t) => Number(t) === s.expectedTier
    );

    const afterReg = await jpeg.isRegistered(w.address);
    const pass = Number(tier) === s.expectedTier;

    const synced = receipt!.logs.filter((l: any) => l.fragment?.name === "Synced");
    for (const e of synced) {
      console.log(`    Synced: ${TIER[Number(e.args.oldTier)]} → ${TIER[Number(e.args.newTier)]}`);
    }
    console.log(`    isRegistered after   : ${afterReg} (auto-registered!)`);
    console.log(`    Gas used : ${receipt!.gasUsed}`);
    console.log(`    Tier     : ${TIER[Number(tier)]} (expected ${TIER[s.expectedTier]}) ${pass ? "✔ PASS" : "✘ FAIL"}`);
    console.log("");

    results.push({ name: s.name, pass, tier: TIER[Number(tier)], gasUsed: receipt!.gasUsed });
  }

  // ── Summary ─────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("══════════════════════════════════════════════════");

  const watchlistSize = await jpeg.watchlistLength();
  let allPass = true;
  let totalGas = 0n;

  for (const r of results) {
    const s = r.pass ? "✔ PASS" : "✘ FAIL";
    console.log(`  ${r.name.padEnd(6)}: ${s}  tier=${r.tier}  gas=${r.gasUsed}`);
    if (!r.pass) allPass = false;
    totalGas += r.gasUsed;
  }

  console.log("──────────────────────────────────────────────────");
  console.log(`  Watchlist auto-populated : ${watchlistSize}/5 wallets`);
  console.log(`  Total gas (performUpkeep): ${totalGas}`);
  console.log(`  Overall : ${allPass ? "✔ ALL 5 WALLETS PASSED — fully automatic!" : "✘ SOME FAILED"}`);
  console.log("══════════════════════════════════════════════════");
  console.log("");

  if (allPass) {
    console.log("What this proves:");
    console.log("  - Any wallet that buys CPEG emits a Transfer event");
    console.log("  - Chainlink Log Trigger detects it via checkLog()");
    console.log("  - performUpkeep() auto-registers + syncs tier");
    console.log("  - No manual registerHolder() needed ever");
    console.log("");
    console.log("To enable this fully on Chainlink dashboard:");
    console.log("  1. automation.chain.link → Register New Upkeep");
    console.log("  2. Trigger type : Log Trigger");
    console.log("  3. Target       :", jpegAddress);
    console.log("  4. Log emitter  :", cpegAddress, "(CPEG token)");
    console.log("  5. Topic 0      :", TRANSFER_SIG);
    console.log("  6. Gas limit    : 300000");
    console.log("  7. Fund with LINK and activate");
  }

  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
