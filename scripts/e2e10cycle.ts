/**
 * e2e10cycle.ts — E2E 10-Cycle Chainlink Automation test
 *
 * Cycle plan:
 *   1  None       → Common      mint 10M
 *   2  Common     → Uncommon    mint +40M
 *   3  Uncommon   → Rare        mint +50M
 *   4  Rare       → Epic        mint +400M
 *   5  Epic       → Legendary   mint +500M
 *   6  Legendary  → Mythic      mint +1B
 *   7  Mythic     → Legendary   burn to 1.5B
 *   8  Legendary  → Rare        burn to 150M
 *   9  Rare       → Common      burn to 15M
 *  10  Common     → None        burn all
 */

import { ethers } from "hardhat";

const TIER = ["None", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHECK_DATA = ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256", "uint256"],
  [0, 50]
);

/** Poll until tier matches expected or timeout */
async function pollTier(jpeg: any, holder: string, expected: number, attempts = 6, delayMs = 1500): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const t = Number(await jpeg.tierOf(holder));
    if (t === expected) return t;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return Number(await jpeg.tierOf(holder));
}

/** Poll until CPEG balance satisfies predicate or timeout */
async function pollBalance(cpeg: any, holder: string, predicate: (b: bigint) => boolean, attempts = 6, delayMs = 1500): Promise<bigint> {
  for (let i = 0; i < attempts; i++) {
    const b = await cpeg.balanceOf(holder);
    if (predicate(b)) return b;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return cpeg.balanceOf(holder);
}

async function runCycle(
  cycleNum: number,
  label: string,
  jpeg: any,
  cpeg: any,
  holder: string,
  expectedTier: number,
  expectedBalance: bigint,
): Promise<{ pass: boolean; gasUsed: bigint }> {
  console.log(`\n── Cycle ${cycleNum}: ${label} ──`);

  // Wait for balance to reflect expected on-chain state
  const bal = await pollBalance(cpeg, holder, (b) => b === expectedBalance);
  const tierBefore = await jpeg.tierOf(holder);
  console.log(`   Balance  : ${ethers.formatEther(bal)} CPEG`);
  console.log(`   Tier now : ${TIER[Number(tierBefore)]}`);

  if (bal !== expectedBalance) {
    console.log(`   FAIL: balance mismatch (got ${ethers.formatEther(bal)}, expected ${ethers.formatEther(expectedBalance)})`);
    return { pass: false, gasUsed: 0n };
  }

  // checkUpkeep (view — always fresh via Alchemy)
  const [needed, performData] = await jpeg.checkUpkeep.staticCall(CHECK_DATA);
  console.log(`   checkUpkeep → upkeepNeeded: ${needed}`);

  if (!needed) {
    const currentTier = Number(await jpeg.tierOf(holder));
    if (currentTier === expectedTier) {
      console.log(`   Already in sync — PASS`);
      return { pass: true, gasUsed: 0n };
    }
    console.log(`   FAIL: upkeepNeeded=false but tier wrong (got ${TIER[currentTier]}, expected ${TIER[expectedTier]})`);
    return { pass: false, gasUsed: 0n };
  }

  // performUpkeep
  const tx = await jpeg.performUpkeep(performData, { gasLimit: 500000 });
  const receipt = await tx.wait();
  console.log(`   Gas used : ${receipt.gasUsed.toString()}`);
  console.log(`   Tx hash  : ${tx.hash}`);

  const synced = receipt.logs.filter((l: any) => l.fragment?.name === "Synced");
  for (const e of synced) {
    console.log(`   Synced: ${TIER[Number(e.args.oldTier)]} → ${TIER[Number(e.args.newTier)]}`);
  }

  // Poll for updated tier (avoid stale RPC read)
  const tierAfter = await pollTier(jpeg, holder, expectedTier);
  const pass = tierAfter === expectedTier;
  console.log(`   Expected : ${TIER[expectedTier]} | Got: ${TIER[tierAfter]} | ${pass ? "✔ PASS" : "✘ FAIL"}`);

  return { pass, gasUsed: receipt.gasUsed };
}

async function main() {
  const cpegAddress = process.env.CPEG_TOKEN_ADDRESS;
  const jpegAddress = process.env.CPEG_ADDRESS;
  if (!cpegAddress || !jpegAddress) throw new Error("Set contract addresses in .env");

  const [deployer] = await ethers.getSigners();
  const cpeg = await ethers.getContractAt("MockCPEG", cpegAddress);
  const jpeg = await ethers.getContractAt("CPEG", jpegAddress);
  const holder = deployer.address;

  console.log("══════════════════════════════════════════");
  console.log("  CPEG — E2E 10-Cycle Automation");
  console.log("══════════════════════════════════════════");
  console.log("Contract :", jpegAddress);
  console.log("Holder   :", holder);

  // ── Reset: zero out balance & sync to None ────────────
  console.log("\n[Setup] Resetting holder state...");
  const existingBal = await cpeg.balanceOf(holder);
  if (existingBal > 0n) {
    const throwaway = ethers.Wallet.createRandom().address;
    await (await cpeg.transfer(throwaway, existingBal, { gasLimit: 100000 })).wait();
    await pollBalance(cpeg, holder, (b) => b === 0n);
  }
  const existingTier = Number(await jpeg.tierOf(holder));
  if (existingTier !== 0) {
    await (await jpeg.sync(holder, { gasLimit: 300000 })).wait();
    await pollTier(jpeg, holder, 0);
  }
  await (await jpeg.registerHolder(holder, { gasLimit: 150000 })).wait();
  await sleep(1000);
  console.log("[Setup] Done — tier: None, balance: 0");

  const P = (n: string) => ethers.parseEther(n);

  type Cycle = {
    label: string;
    action: () => Promise<void>;
    expectedTier: number;
    expectedBalance: bigint;
  };

  const cycles: Cycle[] = [
    {
      label: "None → Common (mint 10M)",
      action: async () => {
        await (await cpeg.mint(holder, P("10000000"), { gasLimit: 100000 })).wait();
        await pollBalance(cpeg, holder, (b) => b === P("10000000"));
      },
      expectedTier: 1,
      expectedBalance: P("10000000"),
    },
    {
      label: "Common → Uncommon (mint +40M → 50M)",
      action: async () => {
        await (await cpeg.mint(holder, P("40000000"), { gasLimit: 100000 })).wait();
        await pollBalance(cpeg, holder, (b) => b === P("50000000"));
      },
      expectedTier: 2,
      expectedBalance: P("50000000"),
    },
    {
      label: "Uncommon → Rare (mint +50M → 100M)",
      action: async () => {
        await (await cpeg.mint(holder, P("50000000"), { gasLimit: 100000 })).wait();
        await pollBalance(cpeg, holder, (b) => b === P("100000000"));
      },
      expectedTier: 3,
      expectedBalance: P("100000000"),
    },
    {
      label: "Rare → Epic (mint +400M → 500M)",
      action: async () => {
        await (await cpeg.mint(holder, P("400000000"), { gasLimit: 100000 })).wait();
        await pollBalance(cpeg, holder, (b) => b === P("500000000"));
      },
      expectedTier: 4,
      expectedBalance: P("500000000"),
    },
    {
      label: "Epic → Legendary (mint +500M → 1B)",
      action: async () => {
        await (await cpeg.mint(holder, P("500000000"), { gasLimit: 100000 })).wait();
        await pollBalance(cpeg, holder, (b) => b === P("1000000000"));
      },
      expectedTier: 5,
      expectedBalance: P("1000000000"),
    },
    {
      label: "Legendary → Mythic (mint +1B → 2B)",
      action: async () => {
        await (await cpeg.mint(holder, P("1000000000"), { gasLimit: 100000 })).wait();
        await pollBalance(cpeg, holder, (b) => b === P("2000000000"));
      },
      expectedTier: 6,
      expectedBalance: P("2000000000"),
    },
    {
      label: "Mythic → Legendary (burn to 1.5B)",
      action: async () => {
        const target = P("1500000000");
        const bal = await cpeg.balanceOf(holder);
        const throwaway = ethers.Wallet.createRandom().address;
        await (await cpeg.transfer(throwaway, bal - target, { gasLimit: 100000 })).wait();
        await pollBalance(cpeg, holder, (b) => b === target);
      },
      expectedTier: 5,
      expectedBalance: P("1500000000"),
    },
    {
      label: "Legendary → Rare (burn to 150M)",
      action: async () => {
        const target = P("150000000");
        const bal = await cpeg.balanceOf(holder);
        const throwaway = ethers.Wallet.createRandom().address;
        await (await cpeg.transfer(throwaway, bal - target, { gasLimit: 100000 })).wait();
        await pollBalance(cpeg, holder, (b) => b === target);
      },
      expectedTier: 3,
      expectedBalance: P("150000000"),
    },
    {
      label: "Rare → Common (burn to 15M)",
      action: async () => {
        const target = P("15000000");
        const bal = await cpeg.balanceOf(holder);
        const throwaway = ethers.Wallet.createRandom().address;
        await (await cpeg.transfer(throwaway, bal - target, { gasLimit: 100000 })).wait();
        await pollBalance(cpeg, holder, (b) => b === target);
      },
      expectedTier: 1,
      expectedBalance: P("15000000"),
    },
    {
      label: "Common → None (burn all)",
      action: async () => {
        const bal = await cpeg.balanceOf(holder);
        const throwaway = ethers.Wallet.createRandom().address;
        await (await cpeg.transfer(throwaway, bal, { gasLimit: 100000 })).wait();
        await pollBalance(cpeg, holder, (b) => b === 0n);
      },
      expectedTier: 0,
      expectedBalance: 0n,
    },
  ];

  // ── Run cycles ────────────────────────────────────────
  const results: { cycle: number; label: string; pass: boolean; gasUsed: bigint }[] = [];
  let totalGas = 0n;

  for (let i = 0; i < cycles.length; i++) {
    const { label, action, expectedTier, expectedBalance } = cycles[i];
    await action();
    const { pass, gasUsed } = await runCycle(i + 1, label, jpeg, cpeg, holder, expectedTier, expectedBalance);
    results.push({ cycle: i + 1, label, pass, gasUsed });
    totalGas += gasUsed;
  }

  // ── Summary ───────────────────────────────────────────
  console.log("\n══════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("══════════════════════════════════════════");

  let allPass = true;
  for (const r of results) {
    const status = r.pass ? "✔ PASS" : "✘ FAIL";
    const gas = r.gasUsed > 0n ? `  gas: ${r.gasUsed}` : "  no-op";
    console.log(`  Cycle ${r.cycle.toString().padStart(2)}: ${status}  (${gas})  — ${r.label}`);
    if (!r.pass) allPass = false;
  }

  console.log("──────────────────────────────────────────");
  console.log(`  Total gas : ${totalGas.toString()}`);
  console.log(`  Overall   : ${allPass ? "✔ ALL 10 CYCLES PASSED" : "✘ SOME CYCLES FAILED"}`);
  console.log("══════════════════════════════════════════\n");

  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
