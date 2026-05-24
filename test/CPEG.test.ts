import { expect } from "chai";
import { ethers } from "hardhat";
import { CPEG, MockCPEG } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("CPEG", () => {
  let jpeg: CPEG;
  let cpeg: MockCPEG;
  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  const T = {
    COMMON:    ethers.parseEther("10000000"),
    UNCOMMON:  ethers.parseEther("50000000"),
    RARE:      ethers.parseEther("100000000"),
    EPIC:      ethers.parseEther("500000000"),
    LEGENDARY: ethers.parseEther("1000000000"),
    MYTHIC:    ethers.parseEther("2000000000"),
  };
  const TIER = { NONE: 0, COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4, LEGENDARY: 5, MYTHIC: 6 };

  beforeEach(async () => {
    [owner, keeper, alice, bob, carol] = await ethers.getSigners();

    const MockCPEGFactory = await ethers.getContractFactory("MockCPEG");
    cpeg = await MockCPEGFactory.deploy() as MockCPEG;

    const Factory = await ethers.getContractFactory("CPEG");
    jpeg = await Factory.deploy(
      await cpeg.getAddress(),
      "https://test.cpeg.xyz/{id}.json"
    ) as CPEG;

    await jpeg.setKeeper(keeper.address, true);
  });

  // ============================================================
  // Tier calculation
  // ============================================================

  describe("getTierForBalance()", () => {
    it("returns 0 for zero balance", async () => {
      expect(await jpeg.getTierForBalance(0)).to.equal(TIER.NONE);
    });
    it("returns 0 below Common threshold", async () => {
      expect(await jpeg.getTierForBalance(ethers.parseEther("9999999"))).to.equal(TIER.NONE);
    });
    it("returns Common for exactly 10M", async () => {
      expect(await jpeg.getTierForBalance(T.COMMON)).to.equal(TIER.COMMON);
    });
    it("returns Uncommon for exactly 50M", async () => {
      expect(await jpeg.getTierForBalance(T.UNCOMMON)).to.equal(TIER.UNCOMMON);
    });
    it("returns Rare for 200M", async () => {
      expect(await jpeg.getTierForBalance(ethers.parseEther("200000000"))).to.equal(TIER.RARE);
    });
    it("returns Mythic for 2B+", async () => {
      expect(await jpeg.getTierForBalance(ethers.parseEther("5000000000"))).to.equal(TIER.MYTHIC);
    });
  });

  // ============================================================
  // sync() - minting / upgrading / downgrading / burning
  // ============================================================

  describe("sync()", () => {
    it("mints Common NFT when balance crosses 10M", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await jpeg.connect(keeper).sync(alice.address);
      expect(await jpeg.balanceOf(alice.address, TIER.COMMON)).to.equal(1);
      expect(await jpeg.tierOf(alice.address)).to.equal(TIER.COMMON);
    });

    it("emits Synced event on first mint", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await expect(jpeg.connect(keeper).sync(alice.address))
        .to.emit(jpeg, "Synced")
        .withArgs(alice.address, TIER.NONE, TIER.COMMON);
    });

    it("burns old NFT and mints new on tier upgrade", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await jpeg.connect(keeper).sync(alice.address);
      await cpeg.mint(alice.address, T.UNCOMMON);
      await jpeg.connect(keeper).sync(alice.address);
      expect(await jpeg.balanceOf(alice.address, TIER.COMMON)).to.equal(0);
      expect(await jpeg.balanceOf(alice.address, TIER.UNCOMMON)).to.equal(1);
      expect(await jpeg.tierOf(alice.address)).to.equal(TIER.UNCOMMON);
    });

    it("downgrades when balance drops below tier threshold", async () => {
      await cpeg.mint(alice.address, ethers.parseEther("75000000"));
      await jpeg.connect(keeper).sync(alice.address);
      await cpeg.connect(alice).transfer(bob.address, ethers.parseEther("40000000"));
      await jpeg.connect(keeper).sync(alice.address);
      expect(await jpeg.tierOf(alice.address)).to.equal(TIER.COMMON);
    });

    it("burns NFT when balance drops to zero", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await jpeg.connect(keeper).sync(alice.address);
      const bal = await cpeg.balanceOf(alice.address);
      await cpeg.connect(alice).transfer(bob.address, bal);
      await jpeg.connect(keeper).sync(alice.address);
      expect(await jpeg.balanceOf(alice.address, TIER.COMMON)).to.equal(0);
      expect(await jpeg.tierOf(alice.address)).to.equal(TIER.NONE);
    });

    it("emits Synced with newTier=0 on full burn", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await jpeg.connect(keeper).sync(alice.address);
      const bal = await cpeg.balanceOf(alice.address);
      await cpeg.connect(alice).transfer(bob.address, bal);
      await expect(jpeg.connect(keeper).sync(alice.address))
        .to.emit(jpeg, "Synced")
        .withArgs(alice.address, TIER.COMMON, TIER.NONE);
    });

    it("is a no-op when tier has not changed", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await jpeg.connect(keeper).sync(alice.address);
      const tx = await jpeg.connect(keeper).sync(alice.address);
      const receipt = await tx.wait();
      const events = receipt!.logs.filter((l: any) => l.fragment?.name === "Synced");
      expect(events.length).to.equal(0);
    });

    it("reverts for non-keeper callers", async () => {
      await expect(jpeg.connect(alice).sync(alice.address))
        .to.be.revertedWith("Not a keeper");
    });

    it("owner can call sync() without keeper role", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await expect(jpeg.connect(owner).sync(alice.address)).to.not.be.reverted;
    });
  });

  // ============================================================
  // Watchlist management
  // ============================================================

  describe("registerHolder() / unregisterHolder()", () => {
    it("anyone can register a holder", async () => {
      await jpeg.connect(alice).registerHolder(alice.address);
      expect(await jpeg.isRegistered(alice.address)).to.be.true;
      expect(await jpeg.watchlistLength()).to.equal(1);
    });

    it("double-register is a no-op", async () => {
      await jpeg.registerHolder(alice.address);
      await jpeg.registerHolder(alice.address);
      expect(await jpeg.watchlistLength()).to.equal(1);
    });

    it("emits HolderRegistered event", async () => {
      await expect(jpeg.registerHolder(alice.address))
        .to.emit(jpeg, "HolderRegistered")
        .withArgs(alice.address);
    });

    it("registerHolderBatch adds multiple at once", async () => {
      await jpeg.registerHolderBatch([alice.address, bob.address, carol.address]);
      expect(await jpeg.watchlistLength()).to.equal(3);
    });

    it("keeper can unregister a holder", async () => {
      await jpeg.registerHolder(alice.address);
      await jpeg.connect(keeper).unregisterHolder(alice.address);
      expect(await jpeg.isRegistered(alice.address)).to.be.false;
      expect(await jpeg.watchlistLength()).to.equal(0);
    });

    it("unregister uses swap-and-pop (preserves all other entries)", async () => {
      await jpeg.registerHolderBatch([alice.address, bob.address, carol.address]);
      await jpeg.connect(keeper).unregisterHolder(alice.address); // remove first
      expect(await jpeg.watchlistLength()).to.equal(2);
      expect(await jpeg.isRegistered(bob.address)).to.be.true;
      expect(await jpeg.isRegistered(carol.address)).to.be.true;
    });

    it("non-keeper cannot unregister", async () => {
      await jpeg.registerHolder(alice.address);
      await expect(jpeg.connect(alice).unregisterHolder(alice.address))
        .to.be.revertedWith("Not a keeper");
    });
  });

  // ============================================================
  // checkUpkeep()
  // ============================================================

  describe("checkUpkeep()", () => {
    const defaultCheckData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256"], [0, 50]
    );

    it("returns false when watchlist is empty", async () => {
      const [needed] = await jpeg.checkUpkeep(defaultCheckData);
      expect(needed).to.be.false;
    });

    it("returns false when all tiers are up to date", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await jpeg.connect(keeper).sync(alice.address);
      await jpeg.registerHolder(alice.address);
      const [needed] = await jpeg.checkUpkeep(defaultCheckData);
      expect(needed).to.be.false;
    });

    it("returns true and stale address when tier is out of sync", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await jpeg.registerHolder(alice.address);
      // Balance changed but sync not yet called
      const [needed, performData] = await jpeg.checkUpkeep(defaultCheckData);
      expect(needed).to.be.true;
      const [stale] = ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], performData);
      expect(stale).to.deep.equal([alice.address]);
    });

    it("detects multiple stale holders", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await cpeg.mint(bob.address, T.RARE);
      await jpeg.registerHolderBatch([alice.address, bob.address]);
      const [needed, performData] = await jpeg.checkUpkeep(defaultCheckData);
      expect(needed).to.be.true;
      const [stale] = ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], performData);
      expect(stale.length).to.equal(2);
    });

    it("respects startIndex pagination", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await cpeg.mint(bob.address, T.COMMON);
      await jpeg.registerHolderBatch([alice.address, bob.address]);
      // Start from index 1 — should only see bob
      const checkData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [1, 50]);
      const [needed, performData] = await jpeg.checkUpkeep(checkData);
      expect(needed).to.be.true;
      const [stale] = ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], performData);
      expect(stale.length).to.equal(1);
      expect(stale[0]).to.equal(bob.address);
    });

    it("returns false with empty checkData (defaults to 0, MAX_BATCH)", async () => {
      const [needed] = await jpeg.checkUpkeep("0x");
      expect(needed).to.be.false;
    });
  });

  // ============================================================
  // performUpkeep()
  // ============================================================

  describe("performUpkeep()", () => {
    it("syncs all stale holders passed in performData", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await cpeg.mint(bob.address, T.EPIC);
      await jpeg.registerHolderBatch([alice.address, bob.address]);

      const [, performData] = await jpeg.checkUpkeep(
        ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [0, 50])
      );

      await jpeg.performUpkeep(performData);

      expect(await jpeg.tierOf(alice.address)).to.equal(TIER.COMMON);
      expect(await jpeg.tierOf(bob.address)).to.equal(TIER.EPIC);
    });

    it("full Chainlink cycle: register -> checkUpkeep -> performUpkeep", async () => {
      // Simulate the full automated flow
      await cpeg.mint(alice.address, T.RARE);
      await jpeg.registerHolder(alice.address);

      // 1. Chainlink node calls checkUpkeep
      const checkData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [0, 50]);
      const [needed, performData] = await jpeg.checkUpkeep(checkData);
      expect(needed).to.be.true;

      // 2. Chainlink node calls performUpkeep
      await jpeg.performUpkeep(performData);

      // 3. Alice now has a Rare NFT
      expect(await jpeg.tierOf(alice.address)).to.equal(TIER.RARE);
      expect(await jpeg.balanceOf(alice.address, TIER.RARE)).to.equal(1);

      // 4. Next checkUpkeep: no more stale
      const [neededAfter] = await jpeg.checkUpkeep(checkData);
      expect(neededAfter).to.be.false;
    });

    it("reverts when batch is empty", async () => {
      const emptyData = ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [[]]);
      await expect(jpeg.performUpkeep(emptyData)).to.be.revertedWith("Invalid batch");
    });

    it("reverts when batch exceeds MAX_BATCH", async () => {
      const addresses = Array(51).fill(alice.address);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [addresses]);
      await expect(jpeg.performUpkeep(data)).to.be.revertedWith("Invalid batch");
    });
  });

  // ============================================================
  // Soulbound
  // ============================================================

  describe("Soulbound", () => {
    beforeEach(async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await jpeg.connect(keeper).sync(alice.address);
    });

    it("reverts safeTransferFrom between wallets", async () => {
      await expect(
        jpeg.connect(alice).safeTransferFrom(alice.address, bob.address, TIER.COMMON, 1, "0x")
      ).to.be.revertedWith("Soulbound: non-transferable");
    });

    it("reverts setApprovalForAll", async () => {
      await expect(jpeg.connect(alice).setApprovalForAll(bob.address, true))
        .to.be.revertedWith("Soulbound: approvals disabled");
    });
  });

  // ============================================================
  // Rewards
  // ============================================================

  describe("Rewards", () => {
    it("distributes rewards proportional to tier multiplier", async () => {
      await cpeg.mint(alice.address, T.COMMON); // 100 pts
      await cpeg.mint(bob.address, T.RARE);     // 200 pts — total 300 pts
      await jpeg.connect(keeper).sync(alice.address);
      await jpeg.connect(keeper).sync(bob.address);

      await jpeg.depositRewards({ value: ethers.parseEther("3") });

      const alicePending = await jpeg.pendingRewards(alice.address);
      const bobPending   = await jpeg.pendingRewards(bob.address);

      // Alice: 100/300 = 1 ETH, Bob: 200/300 = 2 ETH
      expect(alicePending).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.0001"));
      expect(bobPending).to.be.closeTo(ethers.parseEther("2"), ethers.parseEther("0.0001"));
    });

    it("allows claiming ETH rewards", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await jpeg.connect(keeper).sync(alice.address);
      await jpeg.depositRewards({ value: ethers.parseEther("1") });

      const before = await ethers.provider.getBalance(alice.address);
      const tx      = await jpeg.connect(alice).claim();
      const receipt = await tx.wait();
      const gas     = receipt!.gasUsed * receipt!.gasPrice;
      const after   = await ethers.provider.getBalance(alice.address);

      expect(after + gas - before).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.0001"));
    });

    it("harvests pending rewards before tier change", async () => {
      await cpeg.mint(alice.address, T.COMMON);
      await jpeg.connect(keeper).sync(alice.address);
      await jpeg.depositRewards({ value: ethers.parseEther("1") });

      await cpeg.mint(alice.address, T.UNCOMMON);
      await jpeg.connect(keeper).sync(alice.address); // harvest happens here

      const pending = await jpeg.pendingRewards(alice.address);
      expect(pending).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.0001"));
    });

    it("reverts claim with nothing to claim", async () => {
      await expect(jpeg.connect(alice).claim()).to.be.revertedWith("Nothing to claim");
    });
  });

  // ============================================================
  // Access control
  // ============================================================

  describe("Access control", () => {
    it("revoked keeper cannot call sync()", async () => {
      await jpeg.setKeeper(keeper.address, false);
      await expect(jpeg.connect(keeper).sync(alice.address))
        .to.be.revertedWith("Not a keeper");
    });

    it("setKeeper reverts from non-owner", async () => {
      await expect(jpeg.connect(alice).setKeeper(alice.address, true)).to.be.reverted;
    });
  });
});
