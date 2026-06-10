/**
 * PausableFacet.test.ts
 * Tasks 15.1 — Full PausableFacet lifecycle + integration with settlement/float pause gates
 * Requirements: 11.1–11.7, 16.1–16.7, 36.1–36.7
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployFullDiamond,
  asFacet,
  buildSignedQuote,
  signEIP3009Authorization,
  HARDHAT_PRIVATE_KEYS,
} from "./helpers";

const CORRIDOR_ID = ethers.id("USD_SGD");
const ORACLE_KEY = { privateKey: HARDHAT_PRIVATE_KEYS[1] };
const LP_SOURCE_KEY = HARDHAT_PRIVATE_KEYS[2];

/**
 * Full settlement setup: corridor, partners, margin wallets, minted float.
 * Returns everything needed to call executeSettlement.
 */
async function fullSettlementSetup(amt = ethers.parseEther("100")) {
  const d = await deployFullDiamond();
  const [, , src, dst] = await ethers.getSigners();

  // Configure corridor
  const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
  await tl.configureCorridor(CORRIDOR_ID, true, 1n, 0n, 0, 86399);

  // Queue + execute margin update so bps are set
  const tx = await tl.queueMarginUpdate(CORRIDOR_ID, 30, 10, 20);
  const rcpt = await tx.wait();
  const changeId = rcpt!.logs.find((l: any) => l.fragment?.name === "ChangeQueued")!.args[0];
  await ethers.provider.send("evm_increaseTime", [120]);
  await ethers.provider.send("evm_mine", []);
  await tl.executeChange(changeId);

  // Deploy MarginWallets for lpSource and lpDest
  const MW = await ethers.getContractFactory("MarginWallet");
  const srcMargin = await MW.deploy(d.gsdcAddr, src.address, d.diamondAddr);
  await srcMargin.waitForDeployment();
  const dstMargin = await MW.deploy(d.gsdcAddr, dst.address, d.diamondAddr);
  await dstMargin.waitForDeployment();

  // Register both partners
  const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
  await cg.registerPartner(src.address, src.address, await srcMargin.getAddress(), ethers.id("ks"), [CORRIDOR_ID]);
  await cg.registerPartner(dst.address, dst.address, await dstMargin.getAddress(), ethers.id("kd"), [CORRIDOR_ID]);

  // Mint GSDC to lpSource (enough to cover delivery + margins)
  const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
  await mb.mintFloat(src.address, (amt + (amt * 60n) / 10000n) * 10n);

  return { d, src, dst, amt };
}

/**
 * Execute a single settlement with proper signed quote + EIP-3009 auth.
 */
async function executeValidSettlement(
  d: any,
  src: any,
  dst: any,
  amt: bigint,
  tag: string,
) {
  const sid = ethers.id("s-" + tag);
  const qid = ethers.id("q-" + tag);

  const sq = await buildSignedQuote(d.diamondAddr, ORACLE_KEY, {
    quoteId: qid,
    corridorId: CORRIDOR_ID,
    deliveryAmount: amt,
    lpSourceBps: 30,
    tgsTreasuryBps: 10,
    lpDestBps: 20,
  });

  const authSig = await signEIP3009Authorization({
    tokenAddr: d.gsdcAddr,
    from: { privateKey: LP_SOURCE_KEY, address: src.address },
    to: d.diamondAddr,
    value: sq.totalDebit,
    settlementId: sid,
  });

  const ex = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
  return ex.executeSettlement(
    sid, qid, CORRIDOR_ID, src.address, dst.address,
    amt, sq.encodedQuote, sq.oracleSignature, authSig,
  );
}

describe("PausableFacet", () => {
  // ─── Lifecycle tests ─────────────────────────────────────────────────

  describe("pause()", () => {
    it("sets isPaused() to true and emits Paused event with actor + timestamp", async () => {
      const d = await deployFullDiamond();
      const pausable = await asFacet<any>(d.diamondAddr, "PausableFacet");

      expect(await pausable.isPaused()).to.equal(false);

      const tx = await pausable.pause();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(await pausable.isPaused()).to.equal(true);
      await expect(tx)
        .to.emit(pausable, "Paused")
        .withArgs(d.admin, block!.timestamp);
    });

    it("reverts AlreadyPaused() when called twice", async () => {
      const d = await deployFullDiamond();
      const pausable = await asFacet<any>(d.diamondAddr, "PausableFacet");

      await pausable.pause();

      await expect(pausable.pause())
        .to.be.revertedWithCustomError(pausable, "AlreadyPaused");
    });

    it("reverts when called by non-admin", async () => {
      const d = await deployFullDiamond();
      const [, , , , attacker] = await ethers.getSigners();
      const pausable = await ethers.getContractAt("PausableFacet", d.diamondAddr, attacker);

      await expect(pausable.pause())
        .to.be.revertedWith("LibSettlement: not admin");
    });
  });

  describe("unpause()", () => {
    it("sets isPaused() to false and emits Unpaused event with actor + timestamp", async () => {
      const d = await deployFullDiamond();
      const pausable = await asFacet<any>(d.diamondAddr, "PausableFacet");

      await pausable.pause();
      expect(await pausable.isPaused()).to.equal(true);

      const tx = await pausable.unpause();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(await pausable.isPaused()).to.equal(false);
      await expect(tx)
        .to.emit(pausable, "Unpaused")
        .withArgs(d.admin, block!.timestamp);
    });

    it("reverts NotPaused() when system is not paused", async () => {
      const d = await deployFullDiamond();
      const pausable = await asFacet<any>(d.diamondAddr, "PausableFacet");

      await expect(pausable.unpause())
        .to.be.revertedWithCustomError(pausable, "NotPaused");
    });

    it("reverts when called by non-admin (after admin pauses)", async () => {
      const d = await deployFullDiamond();
      const [, , , , attacker] = await ethers.getSigners();
      const pausable = await asFacet<any>(d.diamondAddr, "PausableFacet");

      await pausable.pause();

      const pausableAttacker = await ethers.getContractAt("PausableFacet", d.diamondAddr, attacker);
      await expect(pausableAttacker.unpause())
        .to.be.revertedWith("LibSettlement: not admin");
    });
  });

  // ─── Integration: pause gates on settlement + float ──────────────────

  describe("SystemPaused gate — SettlementExecutorFacet", () => {
    it("executeSettlement reverts SystemPaused() when paused", async () => {
      const { d, src, dst, amt } = await fullSettlementSetup();

      // Pause the system
      const pausable = await asFacet<any>(d.diamondAddr, "PausableFacet");
      await pausable.pause();

      // Build valid settlement params
      const sid = ethers.id("s-paused");
      const qid = ethers.id("q-paused");
      const sq = await buildSignedQuote(d.diamondAddr, ORACLE_KEY, {
        quoteId: qid,
        corridorId: CORRIDOR_ID,
        deliveryAmount: amt,
        lpSourceBps: 30,
        tgsTreasuryBps: 10,
        lpDestBps: 20,
      });
      const authSig = await signEIP3009Authorization({
        tokenAddr: d.gsdcAddr,
        from: { privateKey: LP_SOURCE_KEY, address: src.address },
        to: d.diamondAddr,
        value: sq.totalDebit,
        settlementId: sid,
      });

      const ex = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(
        ex.executeSettlement(
          sid, qid, CORRIDOR_ID, src.address, dst.address,
          amt, sq.encodedQuote, sq.oracleSignature, authSig,
        ),
      ).to.be.revertedWithCustomError(ex, "SystemPaused");
    });
  });

  describe("SystemPaused gate — FloatManagerFacet", () => {
    it("reserveFloat reverts SystemPaused() when paused", async () => {
      const { d, src, amt } = await fullSettlementSetup();

      // Pause the system
      const pausable = await asFacet<any>(d.diamondAddr, "PausableFacet");
      await pausable.pause();

      const fm = await asFacet<any>(d.diamondAddr, "FloatManagerFacet");
      await expect(
        fm.reserveFloat(src.address, ethers.id("reserve-paused"), amt),
      ).to.be.revertedWithCustomError(fm, "SystemPaused");
    });
  });

  // ─── Round-trip: pause → unpause → settle succeeds ───────────────────

  describe("Pause-unpause round-trip", () => {
    it("executeSettlement succeeds after pause→unpause cycle", async () => {
      const { d, src, dst, amt } = await fullSettlementSetup();

      // Pause then unpause
      const pausable = await asFacet<any>(d.diamondAddr, "PausableFacet");
      await pausable.pause();
      await pausable.unpause();

      // Settlement should go through
      const ex = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(executeValidSettlement(d, src, dst, amt, "roundtrip"))
        .to.emit(ex, "SettlementExecuted");
    });
  });
});
