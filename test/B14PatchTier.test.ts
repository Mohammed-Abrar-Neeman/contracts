// Tier B-14 — patch-tier tests for the 7 in-scope contract fixes.
//
// Covers (per the B-14 brief §3 test scope):
//   C1 — deliveryAmount validation (single-signer + aggregated)
//   C2 — margin BPS sum > 10000 revert on executeChange
//   C3 — admin/orchestrator role separation
//   C4 — meta-time-lock on setTimeLockDelay
//   C5 — EventEmitterFacet non-orchestrator reverts (3 functions)
//   C6 — recoverFailedSettlement no longer routable (selector removed)
//   C7 — executeChange admin gate

import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
  deployFullDiamond,
  asFacet,
  queueAndExecute,
  HARDHAT_PRIVATE_KEYS,
  buildSignedQuote,
  buildSignedAggregatedQuote,
  signEIP3009Authorization,
} from "./helpers";

const CORRIDOR_ID = ethers.encodeBytes32String("INR_CNH");
const TL_DELAY_SECS = 70; // > helpers.ts timeLockDelay (60)

async function increaseTime(seconds: number): Promise<void> {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}
// Backward-compat alias used by tests below.
const time = { increase: increaseTime };

describe("[B-14] Patch tier — contract fixes", () => {

  // ─── C1 — deliveryAmount validation ──────────────────────────────
  describe("[B-14 C1] executeSettlement binds deliveryAmount to signed quote", () => {
    it("reverts DeliveryAmountMismatch when delivery_amount param != signed amount", async () => {
      const d = await deployFullDiamond();
      const [, , src, dst] = await ethers.getSigners();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
      const MW = await ethers.getContractFactory("MarginWallet");
      const srcMW = await MW.deploy(d.gsdcAddr, src.address, d.diamondAddr); await srcMW.waitForDeployment();
      const dstMW = await MW.deploy(d.gsdcAddr, dst.address, d.diamondAddr); await dstMW.waitForDeployment();
      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      await cg.registerPartner(src.address, src.address, await srcMW.getAddress(), ethers.id("k"), [CORRIDOR_ID]);
      await cg.registerPartner(dst.address, dst.address, await dstMW.getAddress(), ethers.id("k2"), [CORRIDOR_ID]);
      const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
      await mb.mintFloat(src.address, ethers.parseEther("10000"));
      const signedAmount = ethers.parseEther("100");
      const passedAmount = ethers.parseEther("10000"); // mismatch
      const signed = await buildSignedQuote(d.diamondAddr, { privateKey: HARDHAT_PRIVATE_KEYS[1] }, {
        quoteId: ethers.id("q-c1"), corridorId: CORRIDOR_ID, deliveryAmount: signedAmount,
        lpSourceBps: 0, tgsTreasuryBps: 0, lpDestBps: 0,
      });
      const sid = ethers.id("sid-c1");
      const authSig = await signEIP3009Authorization({
        tokenAddr: d.gsdcAddr,
        from: { privateKey: HARDHAT_PRIVATE_KEYS[2], address: src.address },
        to: d.diamondAddr,
        value: signed.totalDebit + (passedAmount - signedAmount),
        settlementId: sid,
      });
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(exec.executeSettlement(
        sid, ethers.id("q-c1"), CORRIDOR_ID, src.address, dst.address,
        passedAmount, signed.encodedQuote, signed.oracleSignature, authSig,
      )).to.be.revertedWithCustomError(exec, "DeliveryAmountMismatch");
    });

    it("aggregated path also binds deliveryAmount", async () => {
      const d = await deployFullDiamond();
      const [, , src, dst] = await ethers.getSigners();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
      const MW = await ethers.getContractFactory("MarginWallet");
      const srcMW = await MW.deploy(d.gsdcAddr, src.address, d.diamondAddr); await srcMW.waitForDeployment();
      const dstMW = await MW.deploy(d.gsdcAddr, dst.address, d.diamondAddr); await dstMW.waitForDeployment();
      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      await cg.registerPartner(src.address, src.address, await srcMW.getAddress(), ethers.id("k"), [CORRIDOR_ID]);
      await cg.registerPartner(dst.address, dst.address, await dstMW.getAddress(), ethers.id("k2"), [CORRIDOR_ID]);
      const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
      await mb.mintFloat(src.address, ethers.parseEther("10000"));
      const donKeys = [
        ethers.keccak256(ethers.toUtf8Bytes("b14-c1-don-1")),
        ethers.keccak256(ethers.toUtf8Bytes("b14-c1-don-2")),
        ethers.keccak256(ethers.toUtf8Bytes("b14-c1-don-3")),
      ];
      const donAddrs = donKeys.map((k) => new ethers.Wallet(k).address);
      const gov = await asFacet<any>(d.diamondAddr, "OracleGovernanceFacet");
      // [B-16 β-2] audit: NEW-010 — queue+execute path.
      await queueAndExecute(d.diamondAddr, "OracleGovernanceFacet",
        "queueOracleSignersChange", [donAddrs, 3]);
      void gov;
      const signed = await buildSignedAggregatedQuote(d.diamondAddr, donKeys, {
        quoteId: ethers.id("q-c1a"), corridorId: CORRIDOR_ID, deliveryAmount: ethers.parseEther("100"),
        lpSourceBps: 0, tgsTreasuryBps: 0, lpDestBps: 0,
      });
      const sid = ethers.id("sid-c1a");
      const authSig = await signEIP3009Authorization({
        tokenAddr: d.gsdcAddr,
        from: { privateKey: HARDHAT_PRIVATE_KEYS[2], address: src.address },
        to: d.diamondAddr,
        value: signed.totalDebit * 2n,
        settlementId: sid,
      });
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      await expect(exec.executeSettlementAggregated(
        sid, ethers.id("q-c1a"), CORRIDOR_ID, src.address, dst.address,
        ethers.parseEther("9999"), signed.encodedQuote, signed.signatures, signed.reportsRoot, authSig,
      )).to.be.revertedWithCustomError(exec, "DeliveryAmountMismatch");
    });
  });

  // ─── C2 — margin BPS sum validation ──────────────────────────────
  describe("[B-14 C2] executeChange rejects margin BPS sum > 10000", () => {
    it("queues + reverts MarginBpsSumExceedsMax", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      const tx = await tl.queueMarginUpdate(CORRIDOR_ID, 5000, 5000, 5000); // 15000 bps
      const rc = await tx.wait();
      const ev = rc!.logs.find((l: any) => l.fragment && l.fragment.name === "ChangeQueued");
      const changeId = ev.args.changeId;
      await time.increase(TL_DELAY_SECS);
      await expect(tl.executeChange(changeId))
        .to.be.revertedWithCustomError(tl, "MarginBpsSumExceedsMax");
    });

    it("accepts bps sum == 10000 (boundary)", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
      const tx = await tl.queueMarginUpdate(CORRIDOR_ID, 3333, 3334, 3333); // 10000
      const rc = await tx.wait();
      const ev = rc!.logs.find((l: any) => l.fragment && l.fragment.name === "ChangeQueued");
      const changeId = ev.args.changeId;
      await time.increase(TL_DELAY_SECS);
      await expect(tl.executeChange(changeId)).to.emit(tl, "ChangeExecuted");
    });
  });

  // ─── C3 — admin/orchestrator role separation (queue/execute path) ─
  describe("[B-14 C3 + B-16 β-1] admin/orchestrator role separation via time-lock", () => {
    it("queueOrchestratorChange + executeChange emits OrchestratorChanged + rotates ds.orchestrator", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      const newOrch = ethers.Wallet.createRandom().address;
      const tx = await tl.queueOrchestratorChange(newOrch);
      const rc = await tx.wait();
      const ev = rc!.logs.find((l: any) => l.fragment && l.fragment.name === "ChangeQueued");
      const changeId = ev.args.changeId;
      await time.increase(TL_DELAY_SECS);
      await expect(tl.executeChange(changeId))
        .to.emit(tl, "OrchestratorChanged").withArgs(newOrch);
    });

    it("queueOrchestratorChange rejects zero at queue time", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await expect(tl.queueOrchestratorChange(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(tl, "ZeroOrchestrator");
    });

    it("non-admin cannot queueOrchestratorChange", async () => {
      const d = await deployFullDiamond();
      const [, , nonAdmin] = await ethers.getSigners();
      const tl = (await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet")).connect(nonAdmin);
      await expect(tl.queueOrchestratorChange(ethers.Wallet.createRandom().address))
        .to.be.revertedWith("LibSettlement: not admin");
    });

    it("after rotating orchestrator to distinct EOA via queue+execute, settlement-state calls require new EOA", async () => {
      const d = await deployFullDiamond();
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      const [, , newOrch] = await ethers.getSigners();
      await queueAndExecute(d.diamondAddr, "TimeLockControllerFacet",
        "queueOrchestratorChange", [newOrch.address]);
      // Old admin EOA can no longer drive settlement (would call
      // enforceOrchestrator). MintBurnAuthority + corridor admin still
      // work because those use enforceAdmin separately.
      const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
      const [, , src] = await ethers.getSigners();
      // admin keeps mint authority
      await expect(mb.mintFloat(src.address, ethers.parseEther("1"))).to.not.be.reverted;
    });
  });

  // ─── C4 — meta-time-lock on setTimeLockDelay ─────────────────────
  describe("[B-14 C4] meta-time-lock on setTimeLockDelay", () => {
    it("queueTimeLockDelayChange uses CURRENT delay as the gate", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      // Step 1: bump delay to 1000s, gated by the CURRENT delay (60s).
      await tl.queueTimeLockDelayChange(1000);
      await time.increase(TL_DELAY_SECS);
      await tl.executeTimeLockDelayChange();
      // Step 2: try to lower delay back to 0 — must wait the NEW 1000s
      // delay, so executing after only 60s reverts.
      await tl.queueTimeLockDelayChange(0);
      await time.increase(70);
      await expect(tl.executeTimeLockDelayChange())
        .to.be.revertedWithCustomError(tl, "DelayChangeNotReady");
      // After full 1000s the delay change can execute.
      await time.increase(1001);
      await expect(tl.executeTimeLockDelayChange())
        .to.emit(tl, "TimeLockDelayExecuted").withArgs(0);
    });

    it("executeTimeLockDelayChange without queue reverts DelayChangeNotFound", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await expect(tl.executeTimeLockDelayChange())
        .to.be.revertedWithCustomError(tl, "DelayChangeNotFound");
    });

    it("setTimeLockDelay (immediate-effect) is no longer present", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      expect((tl as any).setTimeLockDelay).to.equal(undefined);
    });
  });

  // ─── C5 — EventEmitterFacet access control ───────────────────────
  describe("[B-14 C5] EventEmitterFacet requires orchestrator", () => {
    it("emitSettlementBroadcast from non-orchestrator reverts", async () => {
      const d = await deployFullDiamond();
      const [, , bystander] = await ethers.getSigners();
      const ee = (await asFacet<any>(d.diamondAddr, "EventEmitterFacet")).connect(bystander);
      await expect(ee.emitSettlementBroadcast(ethers.id("s"), CORRIDOR_ID, "0x"))
        .to.be.revertedWith("LibSettlement: not orchestrator");
    });

    it("emitComplianceCheck from non-orchestrator reverts", async () => {
      const d = await deployFullDiamond();
      const [, , bystander] = await ethers.getSigners();
      const ee = (await asFacet<any>(d.diamondAddr, "EventEmitterFacet")).connect(bystander);
      await expect(ee.emitComplianceCheck(ethers.id("s"), "kyc", true, false))
        .to.be.revertedWith("LibSettlement: not orchestrator");
    });

    it("emitAuditTrail from non-orchestrator reverts", async () => {
      const d = await deployFullDiamond();
      const [, , bystander] = await ethers.getSigners();
      const ee = (await asFacet<any>(d.diamondAddr, "EventEmitterFacet")).connect(bystander);
      await expect(ee.emitAuditTrail(ethers.id("s"), "event", "0x"))
        .to.be.revertedWith("LibSettlement: not orchestrator");
    });

    it("orchestrator can emit — happy path", async () => {
      const d = await deployFullDiamond();
      const ee = await asFacet<any>(d.diamondAddr, "EventEmitterFacet");
      await expect(ee.emitAuditTrail(ethers.id("s"), "event", "0x"))
        .to.emit(ee, "AuditTrailEmitted");
    });
  });

  // ─── C6 — recoverFailedSettlement removed ────────────────────────
  describe("[B-14 C6] recoverFailedSettlement REMOVED from facet ABI", () => {
    it("selector is gone — calling it returns no-such-function", async () => {
      const d = await deployFullDiamond();
      const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
      expect((exec as any).recoverFailedSettlement).to.equal(undefined);
    });
  });

  // ─── C7 — executeChange admin gate ───────────────────────────────
  describe("[B-14 C7] executeChange admin gate (defense-in-depth)", () => {
    it("non-admin cannot executeChange even after readyAt", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
      const tx = await tl.queueMarginUpdate(CORRIDOR_ID, 20, 20, 10);
      const rc = await tx.wait();
      const ev = rc!.logs.find((l: any) => l.fragment && l.fragment.name === "ChangeQueued");
      const changeId = ev.args.changeId;
      await time.increase(TL_DELAY_SECS);
      const [, , nonAdmin] = await ethers.getSigners();
      const tlNon = tl.connect(nonAdmin);
      await expect(tlNon.executeChange(changeId))
        .to.be.revertedWith("LibSettlement: not admin");
    });

    it("admin can executeChange normally", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CORRIDOR_ID, true, 1, 0, 0, 86399);
      const tx = await tl.queueMarginUpdate(CORRIDOR_ID, 20, 20, 10);
      const rc = await tx.wait();
      const ev = rc!.logs.find((l: any) => l.fragment && l.fragment.name === "ChangeQueued");
      const changeId = ev.args.changeId;
      await time.increase(TL_DELAY_SECS);
      await expect(tl.executeChange(changeId)).to.emit(tl, "ChangeExecuted");
    });
  });

  // ─── B-14 B7 + B-16 β-2 — Unified OracleSignersUpdated event ──────
  describe("[B-14 B7 + B-16 β-2] OracleSignersUpdated event uniformity", () => {
    it("singular oracleSigner rotation emits unified OracleSignersUpdated from executeChange", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      const [admin, oracle, newSigner] = await ethers.getSigners();
      // [B-16 β-2] audit: NEW-010 — setOracleSigner removed; rotation
      // goes queue → execute. Event now emitted from TL._executeOracleSignerSingular.
      const tx = await (await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet"))
        .queueOracleSignerChange(newSigner.address);
      const rcQ = await tx.wait();
      const evQ = rcQ!.logs.find((l: any) => {
        try { return tl.interface.parseLog(l)?.name === "ChangeQueued"; }
        catch { return false; }
      });
      const changeId = tl.interface.parseLog(evQ).args.changeId;
      await time.increase(TL_DELAY_SECS);
      const execTx = await tl.executeChange(changeId);
      const execRc = await execTx.wait();
      const ev = execRc!.logs.find((l: any) => {
        try { return tl.interface.parseLog(l)?.name === "OracleSignersUpdated"; }
        catch { return false; }
      });
      expect(ev, "OracleSignersUpdated event missing on singular path").to.exist;
      const parsed = tl.interface.parseLog(ev);
      expect(parsed.args.actor).to.equal(admin.address);
      expect(parsed.args.oldSigners).to.deep.equal([oracle.address]);
      expect(parsed.args.newSigners).to.deep.equal([newSigner.address]);
      expect(parsed.args.oldThreshold).to.equal(parsed.args.newThreshold);
      expect(parsed.args.eventId).to.match(/^0x[0-9a-f]{64}$/i);
    });

    it("multi-signer rotation emits same event signature with threshold change", async () => {
      const d = await deployFullDiamond();
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      const wallets = Array.from({ length: 4 }, () => ethers.Wallet.createRandom().address);
      const tx = await (await asFacet<any>(d.diamondAddr, "OracleGovernanceFacet"))
        .queueOracleSignersChange(wallets, 3);
      const rcQ = await tx.wait();
      const evQ = rcQ!.logs.find((l: any) => {
        try { return tl.interface.parseLog(l)?.name === "ChangeQueued"; }
        catch { return false; }
      });
      const changeId = tl.interface.parseLog(evQ).args.changeId;
      await time.increase(TL_DELAY_SECS);
      const execRc = await (await tl.executeChange(changeId)).wait();
      const ev = execRc!.logs.find((l: any) => {
        try { return tl.interface.parseLog(l)?.name === "OracleSignersUpdated"; }
        catch { return false; }
      });
      expect(ev, "OracleSignersUpdated event missing on multi path").to.exist;
      const parsed = tl.interface.parseLog(ev);
      expect(parsed.args.newSigners).to.deep.equal(wallets);
      expect(parsed.args.newThreshold).to.equal(3n);
    });

    it("both events resolve to the same canonical signature hash", async () => {
      const d = await deployFullDiamond();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const gov = await asFacet<any>(d.diamondAddr, "OracleGovernanceFacet");
      const sigQv = qv.interface.getEvent("OracleSignersUpdated")!.topicHash;
      const sigGov = gov.interface.getEvent("OracleSignersUpdated")!.topicHash;
      expect(sigQv).to.equal(sigGov);
    });
  });

  // ─── B-14 C8 — isOverridden flag on OracleQuote ───────────────────────
  describe("[B-14 C8] isOverridden flag round-trip via EIP-712 signature", () => {
    it("verifier returns isOverridden=true when orchestrator signs with the flag set", async () => {
      const d = await deployFullDiamond();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const signed = await buildSignedQuote(d.diamondAddr, { privateKey: HARDHAT_PRIVATE_KEYS[1] }, {
        quoteId: ethers.id("q-c8-true"), corridorId: CORRIDOR_ID,
        deliveryAmount: ethers.parseEther("100"),
        lpSourceBps: 20, tgsTreasuryBps: 20, lpDestBps: 10,
        isOverridden: true,
      });
      const decoded = await qv.verifyAndDecodeQuote(signed.encodedQuote, signed.oracleSignature);
      expect(decoded.isOverridden).to.equal(true);
    });

    it("verifier returns isOverridden=false when orchestrator signs without the flag", async () => {
      const d = await deployFullDiamond();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const signed = await buildSignedQuote(d.diamondAddr, { privateKey: HARDHAT_PRIVATE_KEYS[1] }, {
        quoteId: ethers.id("q-c8-false"), corridorId: CORRIDOR_ID,
        deliveryAmount: ethers.parseEther("100"),
        lpSourceBps: 20, tgsTreasuryBps: 20, lpDestBps: 10,
        // isOverridden omitted → defaults to false
      });
      const decoded = await qv.verifyAndDecodeQuote(signed.encodedQuote, signed.oracleSignature);
      expect(decoded.isOverridden).to.equal(false);
    });

    it("tampering with isOverridden post-sign reverts InvalidOracleSignature", async () => {
      // [B-14 C8] Critical CertiK property: an attacker cannot flip the
      // override flag without invalidating the signature. The flag is
      // committed by the EIP-712 struct hash so any post-sign mutation
      // (re-encode tuple with isOverridden=true) breaks recovery.
      const d = await deployFullDiamond();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const signed = await buildSignedQuote(d.diamondAddr, { privateKey: HARDHAT_PRIVATE_KEYS[1] }, {
        quoteId: ethers.id("q-c8-tamper"), corridorId: CORRIDOR_ID,
        deliveryAmount: ethers.parseEther("100"),
        lpSourceBps: 20, tgsTreasuryBps: 20, lpDestBps: 10,
        isOverridden: false,
      });
      // Decode → flip isOverridden → re-encode → submit with original sig.
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["tuple(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,string,bool)"],
        signed.encodedQuote,
      )[0];
      const tamperedTuple = [...decoded];
      tamperedTuple[10] = true; // flip isOverridden 0 → 1
      const tamperedEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,string,bool)"],
        [tamperedTuple],
      );
      await expect(qv.verifyAndDecodeQuote(tamperedEncoded, signed.oracleSignature))
        .to.be.revertedWithCustomError(qv, "InvalidOracleSignature");
    });

    it("ORACLE_QUOTE_TYPEHASH includes bool isOverridden (canonical form)", async () => {
      const d = await deployFullDiamond();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const expected = ethers.keccak256(ethers.toUtf8Bytes(
        "OracleQuote(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount," +
        "uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps," +
        "uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate," +
        "bool isOverridden)"
      ));
      expect(await qv.ORACLE_QUOTE_TYPEHASH()).to.equal(expected);
    });

    it("ORACLE_QUOTE_AGGREGATED_TYPEHASH includes bool isOverridden (canonical form)", async () => {
      const d = await deployFullDiamond();
      const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
      const expected = ethers.keccak256(ethers.toUtf8Bytes(
        "OracleQuoteAggregated(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount," +
        "uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps," +
        "uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate," +
        "bytes32 reportsRoot,bool isOverridden)"
      ));
      expect(await qv.ORACLE_QUOTE_AGGREGATED_TYPEHASH()).to.equal(expected);
    });
  });
});
