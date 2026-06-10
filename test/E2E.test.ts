import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFullDiamond, asFacet, buildSignedQuote, signEIP3009Authorization, HARDHAT_PRIVATE_KEYS } from "./helpers";

const CORRIDOR_ID = ethers.id("INR_CNH");

/** End-to-end happy path: configure corridor, register partners, mint
 *  float, approve Diamond, execute settlement. Validates the atomic
 *  fan-out (delivery + 3 margin transfers) and storage updates. */
describe("E2E — settlement happy path", () => {
  it("executeSettlement performs all four transfers and marks SETTLED", async () => {
    const d = await deployFullDiamond();
    const [admin, _oracle, srcPartner, dstPartner] = await ethers.getSigners();

    // 1. Configure corridor: active, min=1, max=0 (unbounded), window=full day.
    const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
    await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
    // 2. Set bps via the (un-time-locked-for-test) executeChange path.
    const tx = await tl.queueMarginUpdate(CORRIDOR_ID, 30, 10, 20);
    const rcpt = await tx.wait();
    const changeId = rcpt!.logs.find((l: any) => l.fragment?.name === "ChangeQueued")!.args[0];
    await ethers.provider.send("evm_increaseTime", [120]);
    await ethers.provider.send("evm_mine", []);
    await tl.executeChange(changeId);

    // 3. Deploy per-partner margin wallets.
    const MW = await ethers.getContractFactory("MarginWallet");
    const srcMW = await MW.deploy(d.gsdcAddr, srcPartner.address, d.diamondAddr);
    await srcMW.waitForDeployment();
    const dstMW = await MW.deploy(d.gsdcAddr, dstPartner.address, d.diamondAddr);
    await dstMW.waitForDeployment();

    // 4. Register both partners on the corridor.
    const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
    await cg.registerPartner(srcPartner.address, srcPartner.address, await srcMW.getAddress(), ethers.id("kyc-src"), [CORRIDOR_ID]);
    await cg.registerPartner(dstPartner.address, dstPartner.address, await dstMW.getAddress(), ethers.id("kyc-dst"), [CORRIDOR_ID]);

    // 5. Mint GSDC float to source partner (no approve needed — EIP-3009 carries its own auth).
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const delivery = ethers.parseEther("1000");
    // bps: 30 + 10 + 20 = 60bps; total = 1000 + 60bps*1000 = 1006.
    const totalDebit = delivery + (delivery * 60n) / 10_000n;
    await mb.mintFloat(srcPartner.address, totalDebit);

    // 6. Build a real signed quote + EIP-3009 authorization. srcPartner is
    //    Hardhat signer #2; oracle is signer #1 — pull both private keys
    //    from the known mnemonic set.
    const quoteId = ethers.id("q1");
    const sid = ethers.id("settlement-e2e-1");
    const signed = await buildSignedQuote(d.diamondAddr, { privateKey: HARDHAT_PRIVATE_KEYS[1] }, {
      quoteId, corridorId: CORRIDOR_ID, deliveryAmount: delivery,
      lpSourceBps: 30, tgsTreasuryBps: 10, lpDestBps: 20,
    });
    const authSig = await signEIP3009Authorization({
      tokenAddr: d.gsdcAddr,
      from: { privateKey: HARDHAT_PRIVATE_KEYS[2], address: srcPartner.address },
      to: d.diamondAddr,
      value: signed.totalDebit,
      settlementId: sid,
    });

    // 7. Execute settlement.
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    await expect(exec.executeSettlement(
      sid, quoteId, CORRIDOR_ID,
      srcPartner.address, dstPartner.address, delivery,
      signed.encodedQuote, signed.oracleSignature, authSig,
    )).to.emit(exec, "SettlementExecuted");

    // 7. Verify balances + storage.
    expect(await d.gsdcToken.balanceOf(dstPartner.address)).to.equal(delivery);
    expect(await d.gsdcToken.balanceOf(await srcMW.getAddress())).to.equal((delivery * 30n) / 10_000n);
    expect(await d.gsdcToken.balanceOf(d.tgsMarginAddr)).to.equal((delivery * 10n) / 10_000n);
    expect(await d.gsdcToken.balanceOf(await dstMW.getAddress())).to.equal((delivery * 20n) / 10_000n);
    const stored = await exec.getSettlement(sid);
    expect(stored.status).to.equal(2); // SETTLED
    expect(stored.totalDebit).to.equal(totalDebit);
  });

  it("rejects amount below min", async () => {
    const d = await deployFullDiamond();
    const [_, __, src, dst] = await ethers.getSigners();
    const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
    await tl.configureCorridor(CORRIDOR_ID, true, ethers.parseEther("100"), 0, 0, 86399);
    const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
    await cg.registerPartner(src.address, src.address, src.address, ethers.id("k"), [CORRIDOR_ID]);
    await cg.registerPartner(dst.address, dst.address, dst.address, ethers.id("k2"), [CORRIDOR_ID]);
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    await expect(exec.executeSettlement(
      ethers.id("s"), ethers.id("q"), CORRIDOR_ID,
      src.address, dst.address, ethers.parseEther("1"), "0x", "0x", "0x",
    )).to.be.revertedWithCustomError(exec, "AmountBelowMinimum");
  });

  it("rejects amount above max when max > 0", async () => {
    const d = await deployFullDiamond();
    const [_, __, src, dst] = await ethers.getSigners();
    const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
    await tl.configureCorridor(CORRIDOR_ID, true, 1, ethers.parseEther("10"), 0, 86399);
    const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
    await cg.registerPartner(src.address, src.address, src.address, ethers.id("k"), [CORRIDOR_ID]);
    await cg.registerPartner(dst.address, dst.address, dst.address, ethers.id("k2"), [CORRIDOR_ID]);
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    await expect(exec.executeSettlement(
      ethers.id("s"), ethers.id("q"), CORRIDOR_ID,
      src.address, dst.address, ethers.parseEther("100"), "0x", "0x", "0x",
    )).to.be.revertedWithCustomError(exec, "AmountAboveMaximum");
  });

  it("rejects unauthorised partner on corridor", async () => {
    const d = await deployFullDiamond();
    const [_, __, src, dst] = await ethers.getSigners();
    const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
    await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    // Neither partner registered.
    await expect(exec.executeSettlement(
      ethers.id("s"), ethers.id("q"), CORRIDOR_ID,
      src.address, dst.address, 100, "0x", "0x", "0x",
    )).to.be.revertedWithCustomError(exec, "PartnerNotAuthorised");
  });

  it("rejects double-execute on same settlementId", async () => {
    const d = await deployFullDiamond();
    const [, , src, dst] = await ethers.getSigners();
    const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
    await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
    const tx = await tl.queueMarginUpdate(CORRIDOR_ID, 0, 0, 0);
    const rcpt = await tx.wait();
    const cid = rcpt!.logs.find((l: any) => l.fragment?.name === "ChangeQueued")!.args[0];
    await ethers.provider.send("evm_increaseTime", [120]);
    await ethers.provider.send("evm_mine", []);
    await tl.executeChange(cid);

    const MW = await ethers.getContractFactory("MarginWallet");
    const srcMW = await MW.deploy(d.gsdcAddr, src.address, d.diamondAddr); await srcMW.waitForDeployment();
    const dstMW = await MW.deploy(d.gsdcAddr, dst.address, d.diamondAddr); await dstMW.waitForDeployment();
    const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
    await cg.registerPartner(src.address, src.address, await srcMW.getAddress(), ethers.id("k"), [CORRIDOR_ID]);
    await cg.registerPartner(dst.address, dst.address, await dstMW.getAddress(), ethers.id("k2"), [CORRIDOR_ID]);
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const delivery = ethers.parseEther("10");
    await mb.mintFloat(src.address, delivery);

    const sid = ethers.id("dup");
    const quoteId = ethers.id("q-dup");
    const signed = await buildSignedQuote(d.diamondAddr, { privateKey: HARDHAT_PRIVATE_KEYS[1] }, {
      quoteId, corridorId: CORRIDOR_ID, deliveryAmount: delivery,
      lpSourceBps: 0, tgsTreasuryBps: 0, lpDestBps: 0,
    });
    const authSig = await signEIP3009Authorization({
      tokenAddr: d.gsdcAddr,
      from: { privateKey: HARDHAT_PRIVATE_KEYS[2], address: src.address },
      to: d.diamondAddr,
      value: signed.totalDebit,
      settlementId: sid,
    });
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    await exec.executeSettlement(sid, quoteId, CORRIDOR_ID, src.address, dst.address, delivery, signed.encodedQuote, signed.oracleSignature, authSig);
    // Second call must revert at SettlementAlreadyExecuted (which is pre-quote) — empty sigs accepted because we never reach verifier.
    await expect(exec.executeSettlement(sid, quoteId, CORRIDOR_ID, src.address, dst.address, delivery, "0x", "0x", "0x"))
      .to.be.revertedWithCustomError(exec, "SettlementAlreadyExecuted");
  });

  // [B-14 C6] recoverFailedSettlement test REMOVED — the underlying
  // function was deleted along with its admin-bypass shape. See
  // docs/certik-handoff/09_known-deferred.md for the rejection rationale
  // mirroring the force-RECONCILED treatment.
});

describe("MarginSplitterFacet — happy path", () => {
  it("calculateMargins returns the correct three-way split for an active corridor", async () => {
    const d = await deployFullDiamond();
    const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
    await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
    const tx = await tl.queueMarginUpdate(CORRIDOR_ID, 25, 5, 15);
    const rcpt = await tx.wait();
    const cid = rcpt!.logs.find((l: any) => l.fragment?.name === "ChangeQueued")!.args[0];
    await ethers.provider.send("evm_increaseTime", [120]);
    await ethers.provider.send("evm_mine", []);
    await tl.executeChange(cid);

    const ms = await asFacet<any>(d.diamondAddr, "MarginSplitterFacet");
    const [src, tgs, dst] = await ms.calculateMargins(CORRIDOR_ID, 10_000_000n);
    expect(src).to.equal(25_000n);  // 25 bps
    expect(tgs).to.equal(5_000n);   // 5 bps
    expect(dst).to.equal(15_000n);  // 15 bps
  });
});

describe("EventEmitterFacet — remaining methods", () => {
  it("emitComplianceCheck emits ComplianceCheckEmitted", async () => {
    const d = await deployFullDiamond();
    const ee = await asFacet<any>(d.diamondAddr, "EventEmitterFacet");
    await expect(ee.emitComplianceCheck(ethers.id("s"), "AML_SCREEN", true, false))
      .to.emit(ee, "ComplianceCheckEmitted");
  });

  it("emitAuditTrail emits AuditTrailEmitted", async () => {
    const d = await deployFullDiamond();
    const ee = await asFacet<any>(d.diamondAddr, "EventEmitterFacet");
    await expect(ee.emitAuditTrail(ethers.id("s"), "PARTNER_REGISTERED", "0x"))
      .to.emit(ee, "AuditTrailEmitted");
  });
});

describe("DiamondCut — Replace + Remove paths", () => {
  it("replace swaps a selector to a new facet implementation", async () => {
    const d = await deployFullDiamond();
    const newDispute = await ethers.getContractFactory("DisputeResolverFacet");
    const f = await newDispute.deploy();
    await f.waitForDeployment();
    const newAddr = await f.getAddress();
    const sel = newDispute.interface.getFunction("disputeSettlement")!.selector;
    const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
    await expect(cut.diamondCut([{
      facetAddress: newAddr, action: 1, // Replace
      functionSelectors: [sel],
    }], ethers.ZeroAddress, "0x")).to.emit(cut, "DiamondCut");

    const loupe = await asFacet<any>(d.diamondAddr, "DiamondLoupeFacet");
    expect(await loupe.facetAddress(sel)).to.equal(newAddr);
  });

  it("remove sweeps a selector off the diamond", async () => {
    const d = await deployFullDiamond();
    const dr = await ethers.getContractFactory("DisputeResolverFacet");
    const sel = dr.interface.getFunction("disputeSettlement")!.selector;
    const cut = await ethers.getContractAt("IDiamondCut", d.diamondAddr);
    await cut.diamondCut([{
      facetAddress: ethers.ZeroAddress, action: 2, // Remove
      functionSelectors: [sel],
    }], ethers.ZeroAddress, "0x");
    const loupe = await asFacet<any>(d.diamondAddr, "DiamondLoupeFacet");
    expect(await loupe.facetAddress(sel)).to.equal(ethers.ZeroAddress);
  });

  it("loupe.facetFunctionSelectors returns selectors for a given facet", async () => {
    const d = await deployFullDiamond();
    const loupe = await asFacet<any>(d.diamondAddr, "DiamondLoupeFacet");
    const sels = await loupe.facetFunctionSelectors(d.facets["FloatManagerFacet"]);
    expect(sels.length).to.be.greaterThan(0);
  });

  it("loupe.facetAddresses lists every facet in the diamond", async () => {
    const d = await deployFullDiamond();
    const loupe = await asFacet<any>(d.diamondAddr, "DiamondLoupeFacet");
    const addrs = await loupe.facetAddresses();
    // [B-12] +1 for OracleGovernanceFacet, +1 for PausableFacet (now wired).
    expect(addrs.length).to.equal(13);
  });
});
