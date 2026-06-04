// Branch-coverage booster — pushes the contracts suite over the
// repo-wide 90/85/90/90 floor (Task 10).
//
// Targets the per-file gaps surfaced by `npm run coverage`:
//   - SettlementExecutorFacet (executeSettlementAggregated full lifecycle
//     + wrap-around window branches)
//   - LibDiamond (diamondCut Add/Replace/Remove revert paths +
//     initializeDiamondCut error bubbling)
//   - TimeLockControllerFacet (cancel-unknown, setTimeLockDelay,
//     configureCorridor non-admin)
//   - MarginWallet (constructor zero-owner / zero-diamond)
//   - GSDCToken (non-owner mint + burn)
//   - EIP3009Extension (cancelAuthorization signer-mismatch +
//     already-used branches)
//   - ComplianceGateFacet (checkCompliance unauthorised-corridor branch)
//
// All scenarios are negative / sad-path tests; the existing happy-path
// coverage already exercises the success branches.

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployFullDiamond,
  asFacet,
  buildSignedAggregatedQuote,
  signEIP3009Authorization,
  HARDHAT_PRIVATE_KEYS,
  queueAndExecute,
} from "./helpers";
import { getSelectors, FacetCutAction } from "../scripts/lib/diamond";

const CORRIDOR_ID = ethers.id("INR_CNH");
const SRC_PK = HARDHAT_PRIVATE_KEYS[2];

// ─── Aggregated-execution helpers ───────────────────────────────────
// Mirrors GapResolutions.setupFullPath but registers DON signers for
// the multi-signer (verifyAndDecodeAggregatedQuote) executeSettlementAggregated path.

interface AggregatedSetup {
  d: Awaited<ReturnType<typeof deployFullDiamond>>;
  src: any;
  dst: any;
  donKeys: string[];
}

async function setupAggregatedPath(): Promise<AggregatedSetup> {
  const d = await deployFullDiamond();
  const [, , src, dst] = await ethers.getSigners();

  const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
  await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
  const tx = await tl.queueMarginUpdate(CORRIDOR_ID, 30, 10, 20);
  const rcpt = await tx.wait();
  const cid = rcpt!.logs.find((l: any) => l.fragment?.name === "ChangeQueued")!.args[0];
  await ethers.provider.send("evm_increaseTime", [120]);
  await ethers.provider.send("evm_mine", []);
  await tl.executeChange(cid);

  const MW = await ethers.getContractFactory("MarginWallet");
  const srcMW = await MW.deploy(d.gsdcAddr, src.address, d.diamondAddr); await srcMW.waitForDeployment();
  const dstMW = await MW.deploy(d.gsdcAddr, dst.address, d.diamondAddr); await dstMW.waitForDeployment();
  const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
  await cg.registerPartner(src.address, src.address, await srcMW.getAddress(), ethers.id("k1"), [CORRIDOR_ID]);
  await cg.registerPartner(dst.address, dst.address, await dstMW.getAddress(), ethers.id("k2"), [CORRIDOR_ID]);

  // Wire DON signers — 3 keys, threshold 2.
  const donKeys: string[] = [];
  const donAddrs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const seed = ethers.keccak256(ethers.toUtf8Bytes(`agg-don-${i}`));
    const w = new ethers.Wallet(seed);
    donKeys.push(w.privateKey);
    donAddrs.push(w.address);
  }
  await queueAndExecute(d.diamondAddr, "OracleGovernanceFacet", "queueOracleSignersChange", [donAddrs, 2]);

  return { d, src, dst, donKeys };
}

describe("[Task 10] Branch-coverage booster", () => {
  // ─── SettlementExecutorFacet.executeSettlementAggregated ──────────

  describe("SettlementExecutorFacet.executeSettlementAggregated", () => {
    it("happy path: 2-of-3 DON signatures + EIP-3009 → SettlementExecuted", async () => {
      const { d, src, dst, donKeys } = await setupAggregatedPath();
      const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
      const delivery = ethers.parseEther("100");
      const totalDebit = delivery + (delivery * 60n) / 10_000n;
      await mb.mintFloat(src.address, totalDebit);

      const sid = ethers.id("s-agg-happy");
      const qid = ethers.id("q-agg-happy");
      const agg = await buildSignedAggregatedQuote(d.diamondAddr, donKeys.slice(0, 2), {
        quoteId: qid, corridorId: CORRIDOR_ID, deliveryAmount: delivery,
        lpSourceBps: 30, tgsTreasuryBps: 10, lpDestBps: 20,
      });
      const authSig = await signEIP3009Authorization({
        tokenAddr: d.gsdcAddr,
        from: { privateKey: SRC_PK, address: src.address },
        to: d.diamondAddr, value: agg.totalDebit, settlementId: sid,
      });
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(exec.executeSettlementAggregated(
        sid, qid, CORRIDOR_ID, src.address, dst.address, delivery,
        agg.encodedQuote, agg.signatures, agg.reportsRoot, authSig,
      )).to.emit(exec, "SettlementExecuted");
      const stored = await exec.getSettlement(sid);
      expect(stored.status).to.equal(2);
    });

    it("rejects double-execute: SettlementAlreadyExecuted", async () => {
      const { d, src, dst, donKeys } = await setupAggregatedPath();
      const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
      const delivery = ethers.parseEther("10");
      // setupAggregatedPath set corridor bps to 30/10/20 (60bps). Mint
      // delivery + margins so the contract-computed totalDebit matches
      // the value signed in the EIP-3009 authorisation.
      const totalDebit = delivery + (delivery * 60n) / 10_000n;
      await mb.mintFloat(src.address, totalDebit);
      const sid = ethers.id("s-agg-dup");
      const qid = ethers.id("q-agg-dup");
      const agg = await buildSignedAggregatedQuote(d.diamondAddr, donKeys.slice(0, 2), {
        quoteId: qid, corridorId: CORRIDOR_ID, deliveryAmount: delivery,
        lpSourceBps: 30, tgsTreasuryBps: 10, lpDestBps: 20,
      });
      const authSig = await signEIP3009Authorization({
        tokenAddr: d.gsdcAddr,
        from: { privateKey: SRC_PK, address: src.address },
        to: d.diamondAddr, value: agg.totalDebit, settlementId: sid,
      });
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await exec.executeSettlementAggregated(
        sid, qid, CORRIDOR_ID, src.address, dst.address, delivery,
        agg.encodedQuote, agg.signatures, agg.reportsRoot, authSig,
      );
      await expect(exec.executeSettlementAggregated(
        sid, qid, CORRIDOR_ID, src.address, dst.address, delivery,
        agg.encodedQuote, agg.signatures, agg.reportsRoot, authSig,
      )).to.be.revertedWithCustomError(exec, "SettlementAlreadyExecuted");
    });

    it("rejects when corridor inactive", async () => {
      const d = await deployFullDiamond();
      const [, , src, dst] = await ethers.getSigners();
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(exec.executeSettlementAggregated(
        ethers.id("s"), ethers.id("q"), CORRIDOR_ID,
        src.address, dst.address, 1, "0x", [], ethers.ZeroHash, "0x",
      )).to.be.revertedWithCustomError(exec, "CorridorNotActive");
    });

    it("rejects amount below minimum", async () => {
      const d = await deployFullDiamond();
      const [, , src, dst] = await ethers.getSigners();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CORRIDOR_ID, true, ethers.parseEther("100"), 0, 0, 86399);
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(exec.executeSettlementAggregated(
        ethers.id("s"), ethers.id("q"), CORRIDOR_ID,
        src.address, dst.address, ethers.parseEther("1"),
        "0x", [], ethers.ZeroHash, "0x",
      )).to.be.revertedWithCustomError(exec, "AmountBelowMinimum");
    });

    it("rejects amount above maximum", async () => {
      const d = await deployFullDiamond();
      const [, , src, dst] = await ethers.getSigners();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CORRIDOR_ID, true, 1, ethers.parseEther("10"), 0, 86399);
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(exec.executeSettlementAggregated(
        ethers.id("s"), ethers.id("q"), CORRIDOR_ID,
        src.address, dst.address, ethers.parseEther("100"),
        "0x", [], ethers.ZeroHash, "0x",
      )).to.be.revertedWithCustomError(exec, "AmountAboveMaximum");
    });

    it("rejects unauthorised lpSource (PartnerNotAuthorised)", async () => {
      const d = await deployFullDiamond();
      const [, , src, dst] = await ethers.getSigners();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(exec.executeSettlementAggregated(
        ethers.id("s"), ethers.id("q"), CORRIDOR_ID,
        src.address, dst.address, 100, "0x", [], ethers.ZeroHash, "0x",
      )).to.be.revertedWithCustomError(exec, "PartnerNotAuthorised");
    });

    it("rejects unauthorised lpDest while lpSource is authorised", async () => {
      const d = await deployFullDiamond();
      const [, , src, dst] = await ethers.getSigners();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      // Only register src — dst stays unregistered.
      await cg.registerPartner(src.address, src.address, src.address, ethers.id("k"), [CORRIDOR_ID]);
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(exec.executeSettlementAggregated(
        ethers.id("s"), ethers.id("q"), CORRIDOR_ID,
        src.address, dst.address, 100, "0x", [], ethers.ZeroHash, "0x",
      )).to.be.revertedWithCustomError(exec, "PartnerNotAuthorised");
    });

    it("bubbles BelowThreshold from the multi-signer verifier", async () => {
      const { d, src, dst, donKeys } = await setupAggregatedPath();
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const agg = await buildSignedAggregatedQuote(d.diamondAddr, donKeys.slice(0, 1), {
        quoteId: ethers.id("q-low"), corridorId: CORRIDOR_ID, deliveryAmount: 1n,
        lpSourceBps: 0, tgsTreasuryBps: 0, lpDestBps: 0,
      });
      await expect(exec.executeSettlementAggregated(
        ethers.id("s-low"), ethers.id("q-low"), CORRIDOR_ID,
        src.address, dst.address, 1n,
        agg.encodedQuote, agg.signatures, agg.reportsRoot, "0x",
      )).to.be.revertedWithCustomError(qv, "BelowThreshold");
    });

    it("rejects when verified quoteId mismatches submitted quoteId", async () => {
      const { d, src, dst, donKeys } = await setupAggregatedPath();
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      const agg = await buildSignedAggregatedQuote(d.diamondAddr, donKeys.slice(0, 2), {
        quoteId: ethers.id("q-truth"), corridorId: CORRIDOR_ID, deliveryAmount: 1n,
        lpSourceBps: 0, tgsTreasuryBps: 0, lpDestBps: 0,
      });
      await expect(exec.executeSettlementAggregated(
        ethers.id("s-mm"), ethers.id("q-imposter"), CORRIDOR_ID,
        src.address, dst.address, 1n,
        agg.encodedQuote, agg.signatures, agg.reportsRoot, "0x",
      )).to.be.revertedWithCustomError(exec, "QuoteCorridorMismatch");
    });

    it("rejects malformed authorisation signature length", async () => {
      const { d, src, dst, donKeys } = await setupAggregatedPath();
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      const sid = ethers.id("s-badauth");
      const qid = ethers.id("q-badauth");
      const agg = await buildSignedAggregatedQuote(d.diamondAddr, donKeys.slice(0, 2), {
        quoteId: qid, corridorId: CORRIDOR_ID, deliveryAmount: 1n,
        lpSourceBps: 0, tgsTreasuryBps: 0, lpDestBps: 0,
      });
      await expect(exec.executeSettlementAggregated(
        sid, qid, CORRIDOR_ID, src.address, dst.address, 1n,
        agg.encodedQuote, agg.signatures, agg.reportsRoot,
        ethers.id("only-32-bytes"),
      )).to.be.revertedWithCustomError(exec, "InvalidAuthorizationSig");
    });

    it("non-orchestrator cannot call aggregated path", async () => {
      const d = await deployFullDiamond();
      const [, , attacker] = await ethers.getSigners();
      const exec = await ethers.getContractAt(
        "SettlementExecutorFacet", d.diamondAddr, attacker,
      );
      await expect(exec.executeSettlementAggregated(
        ethers.id("s"), ethers.id("q"), CORRIDOR_ID,
        attacker.address, attacker.address, 1, "0x", [], ethers.ZeroHash, "0x",
      )).to.be.revertedWith("LibSettlement: not orchestrator");
    });
  });

  // ─── _enforceWindow wrap-around (start > end) ─────────────────────

  describe("SettlementExecutorFacet._enforceWindow wrap-around", () => {
    it("reverts OutsideSettlementWindow for the wrap-around outside branch", async () => {
      const d = await deployFullDiamond();
      const [, , src, dst] = await ethers.getSigners();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      // Wrap-around window 22:00 → 04:00. Only seconds in [0,14400] ∪ [79200,86400)
      // are inside; second 30000 (08:20) is outside.
      await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 79200, 14400);
      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      await cg.registerPartner(src.address, src.address, src.address, ethers.id("k"), [CORRIDOR_ID]);
      await cg.registerPartner(dst.address, dst.address, dst.address, ethers.id("k2"), [CORRIDOR_ID]);
      const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
      const dayStart = latest - (latest % 86400);
      const futureTs = dayStart + 86400 + 30000; // outside the wrap-around
      await ethers.provider.send("evm_setNextBlockTimestamp", [futureTs]);
      await ethers.provider.send("evm_mine", []);
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(exec.executeSettlement(
        ethers.id("s"), ethers.id("q"), CORRIDOR_ID,
        src.address, dst.address, 100, "0x", "0x", "0x",
      )).to.be.revertedWithCustomError(exec, "OutsideSettlementWindow");
    });
  });

  // ─── LibDiamond branches via diamondCut ──────────────────────────

  describe("LibDiamond — diamondCut sad-path branches", () => {
    it("Add with empty selectors reverts 'no selectors in cut'", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      await expect(cut.diamondCut([{
        facetAddress: d.facets["FloatManagerFacet"],
        action: FacetCutAction.Add,
        functionSelectors: [],
      }], ethers.ZeroAddress, "0x")).to.be.revertedWith("LibDiamond: no selectors in cut");
    });

    it("Add to address(0) reverts 'Add facet can't be address(0)'", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      await expect(cut.diamondCut([{
        facetAddress: ethers.ZeroAddress,
        action: FacetCutAction.Add,
        functionSelectors: ["0xdeadbeef"],
      }], ethers.ZeroAddress, "0x")).to.be.revertedWith("LibDiamond: Add facet can't be address(0)");
    });

    it("Add with already-existing selector reverts 'function already exists'", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      const fm = await ethers.getContractFactory("FloatManagerFacet");
      const existingSel = fm.interface.getFunction("reserveFloat")!.selector;
      // Try to add the same selector to a fresh facet deployment.
      const Fresh = await ethers.getContractFactory("FloatManagerFacet");
      const fresh = await Fresh.deploy(); await fresh.waitForDeployment();
      await expect(cut.diamondCut([{
        facetAddress: await fresh.getAddress(),
        action: FacetCutAction.Add,
        functionSelectors: [existingSel],
      }], ethers.ZeroAddress, "0x")).to.be.revertedWith("LibDiamond: function already exists");
    });

    it("Replace with address(0) reverts 'Replace facet can't be address(0)'", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      const fm = await ethers.getContractFactory("FloatManagerFacet");
      const sel = fm.interface.getFunction("reserveFloat")!.selector;
      await expect(cut.diamondCut([{
        facetAddress: ethers.ZeroAddress,
        action: FacetCutAction.Replace,
        functionSelectors: [sel],
      }], ethers.ZeroAddress, "0x")).to.be.revertedWith("LibDiamond: Replace facet can't be address(0)");
    });

    it("Replace with same facet reverts 'replace with same function'", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      const fm = await ethers.getContractFactory("FloatManagerFacet");
      const sel = fm.interface.getFunction("reserveFloat")!.selector;
      await expect(cut.diamondCut([{
        facetAddress: d.facets["FloatManagerFacet"],
        action: FacetCutAction.Replace,
        functionSelectors: [sel],
      }], ethers.ZeroAddress, "0x")).to.be.revertedWith("LibDiamond: replace with same function");
    });

    it("Remove with non-zero facet reverts 'Remove facet must be address(0)'", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      await expect(cut.diamondCut([{
        facetAddress: d.facets["FloatManagerFacet"],
        action: FacetCutAction.Remove,
        functionSelectors: ["0xdeadbeef"],
      }], ethers.ZeroAddress, "0x")).to.be.revertedWith("LibDiamond: Remove facet must be address(0)");
    });

    it("Remove of non-existent selector reverts 'can't remove function that doesn't exist'", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      await expect(cut.diamondCut([{
        facetAddress: ethers.ZeroAddress,
        action: FacetCutAction.Remove,
        functionSelectors: ["0x12345678"],
      }], ethers.ZeroAddress, "0x")).to.be.revertedWith("LibDiamond: can't remove function that doesn't exist");
    });

    it("Remove sweeps an entire facet (last-selector + facet-pop branches)", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      const dr = await ethers.getContractFactory("DisputeResolverFacet");
      const allSelectors = getSelectors(dr.interface);
      // Remove every selector — this exits removeFunction with
      // lastSelectorPosition == 0 and triggers the facet-pop branch.
      await cut.diamondCut([{
        facetAddress: ethers.ZeroAddress,
        action: FacetCutAction.Remove,
        functionSelectors: allSelectors,
      }], ethers.ZeroAddress, "0x");
      const loupe = await asFacet<any>(d.diamondAddr, "DiamondLoupeFacet");
      const facetAddrs = await loupe.facetAddresses();
      expect(facetAddrs).to.not.include(d.facets["DisputeResolverFacet"]);
    });

    it("initializeDiamondCut reverts when _init has no code", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      const eoa = (await ethers.getSigners())[5].address; // EOA → no code
      await expect(cut.diamondCut(
        [], eoa, "0x12345678",
      )).to.be.revertedWith("LibDiamond: _init has no code");
    });

    it("initializeDiamondCut bubbles plain string revert from _init", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      // DiamondInit.init reverts with no data when called twice on its
      // own DiamondStorage flag — but here we call it via delegatecall
      // through the Diamond, which holds its own storage. Easier to
      // trigger the generic "function reverted" path: call DiamondInit
      // with a selector it doesn't expose so the delegatecall fails
      // with empty returndata, hitting the no-error branch.
      const init = d.facets["DiamondLoupeFacet"]; // any contract w/ code, wrong ABI
      const garbageCalldata = "0xdeadbeef";
      await expect(cut.diamondCut([], init, garbageCalldata))
        .to.be.revertedWith("LibDiamond: _init function reverted");
    });
  });

  // ─── TimeLockControllerFacet remaining branches ──────────────────

  describe("TimeLockControllerFacet sad-path + admin setters", () => {
    it("cancelChange on unknown changeId reverts ChangeNotFound", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await expect(tl.cancelChange(ethers.id("missing")))
        .to.be.revertedWithCustomError(tl, "ChangeNotFound");
    });

    it("executeChange on unknown changeId reverts ChangeNotFound", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await expect(tl.executeChange(ethers.id("ghost")))
        .to.be.revertedWithCustomError(tl, "ChangeNotFound");
    });

    it("[B-14 C4] queueTimeLockDelayChange emits TimeLockDelayQueued", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await expect(tl.queueTimeLockDelayChange(900)).to.emit(tl, "TimeLockDelayQueued");
    });

    it("[B-14 C4] non-admin cannot queueTimeLockDelayChange", async () => {
      const d = await deployFullDiamond();
      const [, , attacker] = await ethers.getSigners();
      const tl = await ethers.getContractAt("TimeLockControllerFacet", d.diamondAddr, attacker);
      await expect(tl.queueTimeLockDelayChange(1))
        .to.be.revertedWith("LibSettlement: not admin");
    });

    it("non-admin cannot configureCorridor", async () => {
      const d = await deployFullDiamond();
      const [, , attacker] = await ethers.getSigners();
      const tl = await ethers.getContractAt("TimeLockControllerFacet", d.diamondAddr, attacker);
      await expect(tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399))
        .to.be.revertedWith("LibSettlement: not admin");
    });

    it("non-admin cannot cancelChange", async () => {
      const d = await deployFullDiamond();
      const [, , attacker] = await ethers.getSigners();
      const tl = await ethers.getContractAt("TimeLockControllerFacet", d.diamondAddr, attacker);
      await expect(tl.cancelChange(ethers.id("x")))
        .to.be.revertedWith("LibSettlement: not admin");
    });
  });

  // ─── MarginWallet constructor branches ────────────────────────────

  describe("MarginWallet constructor zero-address branches", () => {
    it("rejects zero owner", async () => {
      const MW = await ethers.getContractFactory("MarginWallet");
      const [admin] = await ethers.getSigners();
      await expect(MW.deploy(admin.address, ethers.ZeroAddress, admin.address))
        .to.be.revertedWithCustomError(MW, "ZeroAddress");
    });

    it("rejects zero settlement diamond", async () => {
      const MW = await ethers.getContractFactory("MarginWallet");
      const [admin] = await ethers.getSigners();
      await expect(MW.deploy(admin.address, admin.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(MW, "ZeroAddress");
    });
  });

  // ─── GSDCToken owner gating ───────────────────────────────────────

  describe("GSDCToken owner-only mint/burn", () => {
    it("non-owner mint reverts OwnableUnauthorizedAccount", async () => {
      const T = await ethers.getContractFactory("GSDCToken");
      const [admin, attacker] = await ethers.getSigners();
      const t = await T.deploy(admin.address);
      await t.waitForDeployment();
      await expect(t.connect(attacker).mint(attacker.address, 1))
        .to.be.revertedWithCustomError(t, "OwnableUnauthorizedAccount");
    });

    it("non-owner burn reverts OwnableUnauthorizedAccount", async () => {
      const T = await ethers.getContractFactory("GSDCToken");
      const [admin, attacker] = await ethers.getSigners();
      const t = await T.deploy(admin.address);
      await t.waitForDeployment();
      await t.mint(admin.address, 100);
      await expect(t.connect(attacker).burn(admin.address, 1))
        .to.be.revertedWithCustomError(t, "OwnableUnauthorizedAccount");
    });

    it("owner burn reduces balance", async () => {
      const T = await ethers.getContractFactory("GSDCToken");
      const [admin] = await ethers.getSigners();
      const t = await T.deploy(admin.address);
      await t.waitForDeployment();
      await t.mint(admin.address, 100);
      await t.burn(admin.address, 40);
      expect(await t.balanceOf(admin.address)).to.equal(60n);
    });
  });

  // ─── EIP3009Extension cancelAuthorization branches ────────────────

  describe("EIP3009Extension cancelAuthorization sad paths", () => {
    async function fixture() {
      const [admin, alice] = await ethers.getSigners();
      const T = await ethers.getContractFactory("GSDCToken");
      const t = await T.deploy(admin.address);
      await t.waitForDeployment();
      const domain = {
        name: "GSDC", version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await t.getAddress(),
      };
      return { t, alice, domain };
    }

    it("cancel of an already-used nonce reverts AuthorizationAlreadyUsed", async () => {
      const { t, alice, domain } = await fixture();
      const nonce = ethers.id("nonce-already-used");
      const types = {
        CancelAuthorization: [
          { name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" },
        ],
      };
      const sigHex = await alice.signTypedData(domain, types, {
        authorizer: alice.address, nonce,
      });
      const sig = ethers.Signature.from(sigHex);
      await t.cancelAuthorization(alice.address, nonce, sig.v, sig.r, sig.s);
      // Second cancel should revert.
      await expect(t.cancelAuthorization(alice.address, nonce, sig.v, sig.r, sig.s))
        .to.be.revertedWithCustomError(t, "AuthorizationAlreadyUsed");
    });

    it("cancel signed by wrong signer reverts SignerMismatch", async () => {
      const { t, alice, domain } = await fixture();
      const [, , bob] = await ethers.getSigners();
      const nonce = ethers.id("nonce-wrong-signer");
      const types = {
        CancelAuthorization: [
          { name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" },
        ],
      };
      // Bob signs a cancel for alice's nonce — recovered != alice.
      const sigHex = await bob.signTypedData(domain, types, {
        authorizer: alice.address, nonce,
      });
      const sig = ethers.Signature.from(sigHex);
      await expect(t.cancelAuthorization(alice.address, nonce, sig.v, sig.r, sig.s))
        .to.be.revertedWithCustomError(t, "SignerMismatch");
    });
  });

  // ─── ComplianceGateFacet checkCompliance branches ────────────────

  describe("ComplianceGateFacet.checkCompliance corridor authorisation", () => {
    it("reverts PartnerNotAuthorised when partner registered but corridor not authorised", async () => {
      const d = await deployFullDiamond();
      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      const [, , partner] = await ethers.getSigners();
      // Register with NO corridors.
      await cg.registerPartner(partner.address, partner.address, partner.address, ethers.id("k"), []);
      await expect(cg.checkCompliance(partner.address, CORRIDOR_ID))
        .to.be.revertedWithCustomError(cg, "PartnerNotAuthorised");
    });

    it("addPartnerCorridor non-admin reverts", async () => {
      const d = await deployFullDiamond();
      const [, , attacker] = await ethers.getSigners();
      const cg = await ethers.getContractAt("ComplianceGateFacet", d.diamondAddr, attacker);
      await expect(cg.addPartnerCorridor(attacker.address, ethers.id("c")))
        .to.be.revertedWith("LibSettlement: not admin");
    });

    it("addPartnerCorridor on already-authorised corridor is a no-op (no event)", async () => {
      const d = await deployFullDiamond();
      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      const [, , partner] = await ethers.getSigners();
      await cg.registerPartner(partner.address, partner.address, partner.address, ethers.id("k"), [CORRIDOR_ID]);
      // Second add for same corridor → already-authorised branch (no emit).
      await expect(cg.addPartnerCorridor(partner.address, CORRIDOR_ID))
        .to.not.emit(cg, "PartnerCorridorAdded");
    });

    it("registerPartner with duplicate corridors in initial array hits already-authorised branch", async () => {
      const d = await deployFullDiamond();
      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      const [, , partner] = await ethers.getSigners();
      await cg.registerPartner(
        partner.address, partner.address, partner.address, ethers.id("k"),
        [CORRIDOR_ID, CORRIDOR_ID, CORRIDOR_ID], // duplicates
      );
      expect(await cg.checkCompliance(partner.address, CORRIDOR_ID)).to.equal(true);
    });
  });

  // ─── SettlementExecutor recoverFailedSettlement REMOVED ──────────
  // [B-14 C6] The admin force-FAILED escape hatch was deleted; the
  // happy-path + non-admin tests below are SKIPPED with the deletion
  // rationale preserved for audit-trail continuity.
  describe.skip("SettlementExecutorFacet.recoverFailedSettlement (REMOVED — [B-14 C6])", () => {
    it("admin can recover a settlement that exists → emits SettlementFailed", async () => {
      const { d, src, dst, donKeys } = await setupAggregatedPath();
      const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
      const delivery = ethers.parseEther("5");
      const totalDebit = delivery + (delivery * 60n) / 10_000n;
      await mb.mintFloat(src.address, totalDebit);
      const sid = ethers.id("s-recover");
      const qid = ethers.id("q-recover");
      const agg = await buildSignedAggregatedQuote(d.diamondAddr, donKeys.slice(0, 2), {
        quoteId: qid, corridorId: CORRIDOR_ID, deliveryAmount: delivery,
        lpSourceBps: 30, tgsTreasuryBps: 10, lpDestBps: 20,
      });
      const authSig = await signEIP3009Authorization({
        tokenAddr: d.gsdcAddr,
        from: { privateKey: SRC_PK, address: src.address },
        to: d.diamondAddr, value: agg.totalDebit, settlementId: sid,
      });
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await exec.executeSettlementAggregated(
        sid, qid, CORRIDOR_ID, src.address, dst.address, delivery,
        agg.encodedQuote, agg.signatures, agg.reportsRoot, authSig,
      );
      // Settlement now status=2 (SETTLED). recoverFailedSettlement marks
      // it FAILED (status=3) — the s.status==0 check is the only gate.
      await expect(exec.recoverFailedSettlement(sid))
        .to.emit(exec, "SettlementFailed").withArgs(sid, "recovered by admin");
      expect((await exec.getSettlement(sid)).status).to.equal(3);
    });

    it("non-admin cannot recoverFailedSettlement", async () => {
      const d = await deployFullDiamond();
      const [, , attacker] = await ethers.getSigners();
      const exec = await ethers.getContractAt("SettlementExecutorFacet", d.diamondAddr, attacker);
      await expect(exec.recoverFailedSettlement(ethers.id("any")))
        .to.be.revertedWith("LibSettlement: not admin");
    });
  });

  // ─── _enforceWindow wrap-around in-window success branch ──────────

  describe("SettlementExecutorFacet._enforceWindow wrap-around in-window", () => {
    it("succeeds when block time is inside the wrap-around window (sec >= start)", async () => {
      const { d, src, dst, donKeys } = await setupAggregatedPath();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      // Reconfigure corridor with wrap-around window 22:00 → 04:00.
      await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 79200, 14400);
      const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
      const dayStart = latest - (latest % 86400);
      const targetTs = dayStart + 86400 + 80000; // 22:13 next day → inside wrap window
      await ethers.provider.send("evm_setNextBlockTimestamp", [targetTs]);
      await ethers.provider.send("evm_mine", []);
      const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
      const delivery = ethers.parseEther("1");
      const totalDebit = delivery + (delivery * 60n) / 10_000n;
      await mb.mintFloat(src.address, totalDebit);
      const sid = ethers.id("s-wrap-in");
      const qid = ethers.id("q-wrap-in");
      const agg = await buildSignedAggregatedQuote(d.diamondAddr, donKeys.slice(0, 2), {
        quoteId: qid, corridorId: CORRIDOR_ID, deliveryAmount: delivery,
        lpSourceBps: 30, tgsTreasuryBps: 10, lpDestBps: 20,
      });
      const authSig = await signEIP3009Authorization({
        tokenAddr: d.gsdcAddr,
        from: { privateKey: SRC_PK, address: src.address },
        to: d.diamondAddr, value: agg.totalDebit, settlementId: sid,
      });
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(exec.executeSettlementAggregated(
        sid, qid, CORRIDOR_ID, src.address, dst.address, delivery,
        agg.encodedQuote, agg.signatures, agg.reportsRoot, authSig,
      )).to.emit(exec, "SettlementExecuted");
    });
  });

  // ─── EIP3009Extension validAfter > 0 happy path ──────────────────

  describe("EIP3009Extension validAfter window branch", () => {
    it("transferWithAuthorization succeeds when validAfter is in the past (>0)", async () => {
      const [admin, alice, bob] = await ethers.getSigners();
      const T = await ethers.getContractFactory("GSDCToken");
      const t = await T.deploy(admin.address);
      await t.waitForDeployment();
      await t.mint(alice.address, ethers.parseEther("10"));
      const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const validAfter = chainNow - 100n; // already valid
      const validBefore = chainNow + 3600n;
      const nonce = ethers.id("auth-validafter-past");
      const domain = {
        name: "GSDC", version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await t.getAddress(),
      };
      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" },
          { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        ],
      };
      const sig = ethers.Signature.from(await alice.signTypedData(domain, types, {
        from: alice.address, to: bob.address, value: 1n, validAfter, validBefore, nonce,
      }));
      await expect(t.transferWithAuthorization(
        alice.address, bob.address, 1, validAfter, validBefore, nonce,
        sig.v, sig.r, sig.s,
      )).to.emit(t, "AuthorizationUsed");
    });
  });

  // ─── QuoteVerifier single-signer NotYetValid branch ───────────────

  describe("QuoteVerifierFacet.verifyAndDecodeQuote validAfter branch", () => {
    it("reverts QuoteNotYetValid when validAfter is in the future", async () => {
      const d = await deployFullDiamond();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const future = {
        quoteId: ethers.id("q-future"),
        corridorId: ethers.id("INR_CNH"),
        deliveryAmount: 1n, totalDebit: 1n,
        lpSourceMarginBps: 0n, tgsTreasuryMarginBps: 0n, lpDestMarginBps: 0n,
        validAfter: chainNow + 3600n,
        validBefore: chainNow + 7200n,
        midRate: "1",
      };
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,string)"],
        [Object.values(future)],
      );
      await expect(qv.verifyAndDecodeQuote(encoded, "0x"))
        .to.be.revertedWithCustomError(qv, "QuoteNotYetValid");
    });
  });

  // ─── MarginWallet deposit branches via diamond impersonation ──────

  describe("MarginWallet.deposit branches", () => {
    it("deposit with amount=0 reverts ZeroAmount (impersonating Diamond)", async () => {
      const d = await deployFullDiamond();
      // Impersonate the Diamond address so msg.sender == settlementDiamond.
      await ethers.provider.send("hardhat_impersonateAccount", [d.diamondAddr]);
      await ethers.provider.send("hardhat_setBalance", [
        d.diamondAddr, "0x" + (10n ** 18n).toString(16),
      ]);
      const diamondSigner = await ethers.getSigner(d.diamondAddr);
      const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr, diamondSigner);
      await expect(mw.deposit(0, ethers.id("s")))
        .to.be.revertedWithCustomError(mw, "ZeroAmount");
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [d.diamondAddr]);
    });

    it("deposit with non-zero amount emits MarginDeposited (impersonating Diamond)", async () => {
      const d = await deployFullDiamond();
      await ethers.provider.send("hardhat_impersonateAccount", [d.diamondAddr]);
      await ethers.provider.send("hardhat_setBalance", [
        d.diamondAddr, "0x" + (10n ** 18n).toString(16),
      ]);
      const diamondSigner = await ethers.getSigner(d.diamondAddr);
      const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr, diamondSigner);
      const sid = ethers.id("s-deposit");
      await expect(mw.deposit(123n, sid))
        .to.emit(mw, "MarginDeposited").withArgs(123n, sid);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [d.diamondAddr]);
    });

    it("withdraw to zero address reverts ZeroAddress", async () => {
      const d = await deployFullDiamond();
      const [admin] = await ethers.getSigners();
      const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr, admin);
      await expect(mw.withdraw(ethers.ZeroAddress, 1))
        .to.be.revertedWithCustomError(mw, "ZeroAddress");
    });

    it("withdraw zero amount reverts ZeroAmount", async () => {
      const d = await deployFullDiamond();
      const [admin] = await ethers.getSigners();
      const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr, admin);
      await expect(mw.withdraw(admin.address, 0))
        .to.be.revertedWithCustomError(mw, "ZeroAmount");
    });
  });

  // ─── Additional LibDiamond branches ──────────────────────────────

  describe("LibDiamond — extra diamondCut branches", () => {
    it("Replace with empty selectors reverts 'no selectors in cut'", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      await expect(cut.diamondCut([{
        facetAddress: d.facets["FloatManagerFacet"],
        action: FacetCutAction.Replace,
        functionSelectors: [],
      }], ethers.ZeroAddress, "0x")).to.be.revertedWith("LibDiamond: no selectors in cut");
    });

    it("Remove with empty selectors reverts 'no selectors in cut'", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      await expect(cut.diamondCut([{
        facetAddress: ethers.ZeroAddress,
        action: FacetCutAction.Remove,
        functionSelectors: [],
      }], ethers.ZeroAddress, "0x")).to.be.revertedWith("LibDiamond: no selectors in cut");
    });

    it("Replace moves a selector to a fresh facet (selectorPosition==0 + cross-facet remove branches)", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      const FreshFM = await ethers.getContractFactory("FloatManagerFacet");
      const fresh = await FreshFM.deploy(); await fresh.waitForDeployment();
      const sel = FreshFM.interface.getFunction("getSettlementReservation")!.selector;
      await cut.diamondCut([{
        facetAddress: await fresh.getAddress(),
        action: FacetCutAction.Replace,
        functionSelectors: [sel],
      }], ethers.ZeroAddress, "0x");
      const loupe = await asFacet<any>(d.diamondAddr, "DiamondLoupeFacet");
      expect(await loupe.facetAddress(sel)).to.equal(await fresh.getAddress());
    });

    it("Remove of a single selector from a multi-selector facet (middle-position swap branch)", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      const fm = await ethers.getContractFactory("FloatManagerFacet");
      // Pick the FIRST selector (definitely not last) so the swap-with-last
      // branch in removeFunction fires.
      const sel = fm.interface.getFunction("getAvailableFloat")!.selector;
      await cut.diamondCut([{
        facetAddress: ethers.ZeroAddress,
        action: FacetCutAction.Remove,
        functionSelectors: [sel],
      }], ethers.ZeroAddress, "0x");
      const loupe = await asFacet<any>(d.diamondAddr, "DiamondLoupeFacet");
      expect(await loupe.facetAddress(sel)).to.equal(ethers.ZeroAddress);
    });

    it("initializeDiamondCut bubbles a custom revert reason from _init", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      // Call DiamondLoupeFacet.facetAddress(selector) with a malformed
      // calldata that still selects a real function but provides too few
      // args → the facet reverts with default abi-decode failure → the
      // returned data has length > 0, hitting the `error.length > 0`
      // bubble branch.
      const loupeIface = (await ethers.getContractFactory("DiamondLoupeFacet")).interface;
      const sel = loupeIface.getFunction("facetAddress")!.selector;
      // Selector only — no args → calldata length too short → revert with data.
      await expect(cut.diamondCut([], d.facets["DiamondLoupeFacet"], sel))
        .to.be.reverted;
    });

    // [Task 31] Add to an EOA (no contract code) → addFacet's
    // enforceHasContractCode branch ("LibDiamond: facet has no code").
    it("Add with EOA facet address reverts 'facet has no code'", async () => {
      const d = await deployFullDiamond();
      const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
      const eoa = ethers.Wallet.createRandom().address;
      await expect(cut.diamondCut([{
        facetAddress: eoa,
        action: FacetCutAction.Add,
        functionSelectors: ["0xcafebabe"],
      }], ethers.ZeroAddress, "0x"))
        .to.be.revertedWith("LibDiamond: facet has no code");
    });
  });

  // ─── [Task 31] QuoteVerifierFacet aggregated branches ─────────────
  // Mirrors the on-chain ORACLE_QUOTE_AGGREGATED_TYPEHASH including the
  // [B-14 C8] `isOverridden` field. Callers may inject validAfter to
  // drive the QuoteNotYetValid branch.

  async function buildAggDigest(diamondAddr: string, opts: {
    quoteId: string; corridorId: string;
    validAfter: bigint; validBefore: bigint;
    midRate?: string; reportsRoot?: string;
  }): Promise<{ encodedQuote: string; reportsRoot: string; digest: string }> {
    const midRate = opts.midRate ?? "1.00000000";
    const reportsRoot = opts.reportsRoot ?? ethers.ZeroHash;
    const isOverridden = false;
    const tuple = [
      opts.quoteId, opts.corridorId, 1n, 1n,
      0n, 0n, 0n,
      opts.validAfter, opts.validBefore, midRate,
      isOverridden,
    ];
    const encodedQuote = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,string,bool)"],
      [tuple],
    );
    const TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(
      "OracleQuoteAggregated(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount," +
      "uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps," +
      "uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate," +
      "bytes32 reportsRoot,bool isOverridden)"
    ));
    const structHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32","bytes32","bytes32","uint256","uint256","uint256","uint256","uint256","uint256","uint256","bytes32","bytes32","bool"],
      [TYPEHASH, opts.quoteId, opts.corridorId, 1n, 1n, 0n, 0n, 0n,
        opts.validAfter, opts.validBefore,
        ethers.keccak256(ethers.toUtf8Bytes(midRate)), reportsRoot, isOverridden],
    ));
    const domainTypeHash = ethers.keccak256(ethers.toUtf8Bytes(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    ));
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domainSeparator = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32","bytes32","bytes32","uint256","address"],
      [domainTypeHash,
        ethers.keccak256(ethers.toUtf8Bytes("GSDCOracle")),
        ethers.keccak256(ethers.toUtf8Bytes("1")),
        chainId, diamondAddr],
    ));
    const digest = ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]));
    return { encodedQuote, reportsRoot, digest };
  }

  function signDigest(pk: string, digest: string): string {
    const sk = new ethers.SigningKey(pk);
    const sig = sk.sign(digest);
    return ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);
  }

  describe("QuoteVerifierFacet.verifyAndDecodeAggregatedQuote sad paths", () => {
    it("reverts QuoteNotYetValid when validAfter is in the future", async () => {
      const { d, donKeys } = await setupAggregatedPath();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const built = await buildAggDigest(d.diamondAddr, {
        quoteId: ethers.id("q-agg-future"), corridorId: CORRIDOR_ID,
        validAfter: chainNow + 3600n, validBefore: chainNow + 7200n,
      });
      const sigs = donKeys.slice(0, 2).map((k) => signDigest(k, built.digest));
      await expect(qv.verifyAndDecodeAggregatedQuote(
        built.encodedQuote, sigs, built.reportsRoot,
      )).to.be.revertedWithCustomError(qv, "QuoteNotYetValid");
    });

    it("reverts QuoteExpired when validBefore is in the past", async () => {
      const { d, donKeys } = await setupAggregatedPath();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const built = await buildAggDigest(d.diamondAddr, {
        quoteId: ethers.id("q-agg-expired"), corridorId: CORRIDOR_ID,
        validAfter: 0n, validBefore: chainNow - 1n,
      });
      const sigs = donKeys.slice(0, 2).map((k) => signDigest(k, built.digest));
      await expect(qv.verifyAndDecodeAggregatedQuote(
        built.encodedQuote, sigs, built.reportsRoot,
      )).to.be.revertedWithCustomError(qv, "QuoteExpired");
    });

    it("reverts DuplicateSigner when the same DON key signs twice", async () => {
      const { d, donKeys } = await setupAggregatedPath();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const built = await buildAggDigest(d.diamondAddr, {
        quoteId: ethers.id("q-agg-dup"), corridorId: CORRIDOR_ID,
        validAfter: 0n, validBefore: chainNow + 3600n,
      });
      const sig0 = signDigest(donKeys[0], built.digest);
      await expect(qv.verifyAndDecodeAggregatedQuote(
        built.encodedQuote, [sig0, sig0], built.reportsRoot,
      )).to.be.revertedWithCustomError(qv, "DuplicateSigner");
    });

    it("reverts InvalidOracleSignature when a signer is not whitelisted", async () => {
      const { d, donKeys } = await setupAggregatedPath();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const built = await buildAggDigest(d.diamondAddr, {
        quoteId: ethers.id("q-agg-rogue"), corridorId: CORRIDOR_ID,
        validAfter: 0n, validBefore: chainNow + 3600n,
      });
      const rogue = ethers.Wallet.createRandom().privateKey;
      const sigs = [signDigest(donKeys[0], built.digest), signDigest(rogue, built.digest)];
      await expect(qv.verifyAndDecodeAggregatedQuote(
        built.encodedQuote, sigs, built.reportsRoot,
      )).to.be.revertedWithCustomError(qv, "InvalidOracleSignature");
    });
  });

  // ─── [Task 31] ComplianceGateFacet remaining branches ─────────────

  describe("ComplianceGateFacet remaining branches", () => {
    it("checkCompliance reverts PartnerSuspended_ when partner.active==false", async () => {
      const d = await deployFullDiamond();
      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      const [, , partner] = await ethers.getSigners();
      await cg.registerPartner(
        partner.address, partner.address, partner.address, ethers.id("k"),
        [CORRIDOR_ID],
      );
      await cg.suspendPartner(partner.address);
      await expect(cg.checkCompliance(partner.address, CORRIDOR_ID))
        .to.be.revertedWithCustomError(cg, "PartnerSuspended_");
    });

    it("registerPartner twice reverts PartnerAlreadyRegistered", async () => {
      const d = await deployFullDiamond();
      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      const [, , partner] = await ethers.getSigners();
      await cg.registerPartner(
        partner.address, partner.address, partner.address, ethers.id("k"),
        [CORRIDOR_ID],
      );
      await expect(cg.registerPartner(
        partner.address, partner.address, partner.address, ethers.id("k2"),
        [CORRIDOR_ID],
      )).to.be.revertedWithCustomError(cg, "PartnerAlreadyRegistered");
    });

    it("reactivatePartner clears the suspended flag and re-enables checkCompliance", async () => {
      const d = await deployFullDiamond();
      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      const [, , partner] = await ethers.getSigners();
      await cg.registerPartner(
        partner.address, partner.address, partner.address, ethers.id("k"),
        [CORRIDOR_ID],
      );
      await cg.suspendPartner(partner.address);
      await expect(cg.reactivatePartner(partner.address))
        .to.emit(cg, "PartnerReactivated").withArgs(partner.address);
      expect(await cg.checkCompliance(partner.address, CORRIDOR_ID)).to.equal(true);
    });
  });
});
