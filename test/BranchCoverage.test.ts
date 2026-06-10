import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFullDiamond, asFacet, buildSignedQuote, signEIP3009Authorization, HARDHAT_PRIVATE_KEYS, queueAndExecute } from "./helpers";

describe("Branch coverage — targeted edge cases", () => {
  it("QuoteVerifier — happy-path EIP-712 signature accepted", async () => {
    const d = await deployFullDiamond();
    const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");

    // Replace the oracle with a Wallet so we have access to the raw private
    // key for SigningKey.sign(). Hardhat default signers don't expose theirs.
    const oracleWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    // [B-16 β-2] audit: NEW-010 — immediate setOracleSigner removed.
    await queueAndExecute(d.diamondAddr, "QuoteVerifierFacet",
      "queueOracleSignerChange", [oracleWallet.address]);

    // [B-16 β-2] queueAndExecute may evm_increaseTime by up to 60s.
    // Use EVM block time, not wall clock, when computing validBefore.
    const _b = await ethers.provider.getBlock("latest");
    const _bTs = BigInt(_b!.timestamp);
    const validBefore = _bTs + 299n;
    const quote = {
      quoteId: ethers.id("q-happy"),
      corridorId: ethers.id("INR_CNH"),
      deliveryAmount: 1000n,
      totalDebit: 1006n,
      lpSourceMarginBps: 30n,
      tgsTreasuryMarginBps: 10n,
      lpDestMarginBps: 20n,
      validAfter: _bTs - 1n,
      validBefore,
      midRate: "82.50",
      // [B-14 C8] isOverridden bound to signature.
      isOverridden: false,
    };
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,string,bool)"],
      [Object.values(quote)],
    );

    const TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(
      "OracleQuote(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount," +
      "uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps," +
      "uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate," +
      "bool isOverridden)"
    ));
    const structHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32","bytes32","bytes32","uint256","uint256","uint256","uint256","uint256","uint256","uint256","bytes32","bool"],
      [TYPEHASH, quote.quoteId, quote.corridorId, quote.deliveryAmount, quote.totalDebit,
        quote.lpSourceMarginBps, quote.tgsTreasuryMarginBps, quote.lpDestMarginBps,
        quote.validAfter, quote.validBefore, ethers.keccak256(ethers.toUtf8Bytes(quote.midRate)),
        quote.isOverridden],
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
        chainId,
        d.diamondAddr],
    ));
    const digest = ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]));
    const sk = new ethers.SigningKey(oracleWallet.privateKey);
    const sig = sk.sign(digest);
    const rawSig = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);

    const decoded = await qv.verifyAndDecodeQuote(encoded, rawSig);
    expect(decoded.quoteId).to.equal(quote.quoteId);
  });

  it("QuoteVerifier — wrong signer reverts InvalidOracleSignature", async () => {
    const d = await deployFullDiamond();
    const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
    // [B-16 β] Block time may be ahead of wall clock from sibling tests'
    // time-warps. Anchor validBefore to EVM time.
    const _b = await ethers.provider.getBlock("latest");
    const _bTs = BigInt(_b!.timestamp);
    const validBefore = _bTs + 299n;
    const quote = {
      quoteId: ethers.id("q-bad"),
      corridorId: ethers.id("INR_CNH"),
      deliveryAmount: 1n, totalDebit: 1n,
      lpSourceMarginBps: 0n, tgsTreasuryMarginBps: 0n, lpDestMarginBps: 0n,
      validAfter: _bTs - 1n, validBefore, midRate: "1",
      // [B-14 C8] isOverridden bound to signature.
      isOverridden: false,
    };
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,string,bool)"],
      [Object.values(quote)],
    );
    // Sign with a non-oracle signer.
    const [_, __, attacker] = await ethers.getSigners();
    const fakeDigest = ethers.id("anything");
    const sk = ethers.Signature.from(await attacker.signMessage(ethers.getBytes(fakeDigest)));
    const sigBytes = ethers.concat([sk.r, sk.s, ethers.toBeHex(sk.v, 1)]);
    await expect(qv.verifyAndDecodeQuote(encoded, sigBytes))
      .to.be.revertedWithCustomError(qv, "InvalidOracleSignature");
  });

  it("SettlementExecutor — outside settlement window reverts", async () => {
    const d = await deployFullDiamond();
    const [_, __, src, dst] = await ethers.getSigners();
    const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
    // Get current block timestamp + compute an "in the future" point that
    // lands at second 50 of its day (definitely outside a [100,200] window).
    const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
    const dayStart = latest - (latest % 86400);
    // Pick a future block ts at dayStart+86400+50 → second 50 of next day.
    const futureTs = dayStart + 86400 + 50;
    // Window: [100, 200] of each day → 50 is OUTSIDE.
    await tl.configureCorridor(ethers.id("INR_CNH"), true, 1, 0, 100, 200);
    const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
    await cg.registerPartner(src.address, src.address, src.address, ethers.id("k"), [ethers.id("INR_CNH")]);
    await cg.registerPartner(dst.address, dst.address, dst.address, ethers.id("k2"), [ethers.id("INR_CNH")]);
    await ethers.provider.send("evm_setNextBlockTimestamp", [futureTs]);
    await ethers.provider.send("evm_mine", []);
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    await expect(exec.executeSettlement(
      ethers.id("s"), ethers.id("q"), ethers.id("INR_CNH"),
      src.address, dst.address, 100, "0x", "0x", "0x",
    )).to.be.revertedWithCustomError(exec, "OutsideSettlementWindow");
  });

  it("MarginWallet — withdraw to zero-address reverts", async () => {
    const d = await deployFullDiamond();
    const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr);
    await expect(mw.withdraw(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(mw, "ZeroAddress");
  });

  it("MarginWallet — withdraw zero amount reverts", async () => {
    const d = await deployFullDiamond();
    const [admin] = await ethers.getSigners();
    const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr);
    await expect(mw.withdraw(admin.address, 0)).to.be.revertedWithCustomError(mw, "ZeroAmount");
  });

  it("MarginWallet — deposit with zero amount reverts", async () => {
    const d = await deployFullDiamond();
    // Impersonate the Diamond to call deposit; localhost only.
    await ethers.provider.send("hardhat_impersonateAccount", [d.diamondAddr]);
    await ethers.provider.send("hardhat_setBalance", [d.diamondAddr, "0xDE0B6B3A7640000"]);
    const diamondSigner = await ethers.getSigner(d.diamondAddr);
    const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr, diamondSigner);
    await expect(mw.deposit(0, ethers.id("s"))).to.be.revertedWithCustomError(mw, "ZeroAmount");
  });

  it("EIP3009 — bad signature length reverts via OZ ECDSAInvalidSignature", async () => {
    const T = await ethers.getContractFactory("GSDCToken");
    const [admin] = await ethers.getSigners();
    const t = await T.deploy(admin.address);
    await t.waitForDeployment();
    // OpenZeppelin v5 ECDSA.recover guards r/s against malleability and
    // reverts with ECDSAInvalidSignature for all-zero r/s. The custom
    // InvalidSignature() branch in EIP3009Extension is reachable only via
    // ECDSA returning address(0), which OZ v5 prevents — leaving this OZ
    // revert as the canonical "bad signature" path. Recorded as [GAP];
    // auditor may want to drop the InvalidSignature() check or wrap the
    // OZ revert in our error type before mainnet.
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await expect(t.transferWithAuthorization(
      admin.address, admin.address, 1, 0, validBefore, ethers.id("n"),
      27, ethers.ZeroHash, ethers.ZeroHash,
    )).to.be.reverted; // OZ ECDSAInvalidSignature, but not our error type.
  });

  it("ComplianceGateFacet — addPartnerCorridor adds + dedupes", async () => {
    const d = await deployFullDiamond();
    const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
    const [_, __, partner] = await ethers.getSigners();
    await cg.registerPartner(partner.address, partner.address, partner.address, ethers.id("k"), []);
    await expect(cg.addPartnerCorridor(partner.address, ethers.id("c1")))
      .to.emit(cg, "PartnerCorridorAdded");
    // Second add (dedupe) emits no event.
    const tx = await cg.addPartnerCorridor(partner.address, ethers.id("c1"));
    const rcpt = await tx.wait();
    const evt = rcpt!.logs.find((l: any) => l.fragment?.name === "PartnerCorridorAdded");
    expect(evt).to.equal(undefined);
  });

  it("DisputeResolverFacet — happy path emits SettlementDisputed", async () => {
    const d = await deployFullDiamond();
    const [, , src, dst] = await ethers.getSigners();
    const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
    await tl.configureCorridor(ethers.id("INR_CNH"), true, 1, 0, 0, 86399);
    const MW = await ethers.getContractFactory("MarginWallet");
    const srcMW = await MW.deploy(d.gsdcAddr, src.address, d.diamondAddr); await srcMW.waitForDeployment();
    const dstMW = await MW.deploy(d.gsdcAddr, dst.address, d.diamondAddr); await dstMW.waitForDeployment();
    const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
    await cg.registerPartner(src.address, src.address, await srcMW.getAddress(), ethers.id("k"), [ethers.id("INR_CNH")]);
    await cg.registerPartner(dst.address, dst.address, await dstMW.getAddress(), ethers.id("k2"), [ethers.id("INR_CNH")]);
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const delivery = ethers.parseEther("5");
    await mb.mintFloat(src.address, delivery);
    const sid = ethers.id("dispute-test");
    const quoteId = ethers.id("q-dispute");
    const signed = await buildSignedQuote(d.diamondAddr, { privateKey: HARDHAT_PRIVATE_KEYS[1] }, {
      quoteId, corridorId: ethers.id("INR_CNH"), deliveryAmount: delivery,
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
    await exec.executeSettlement(sid, quoteId, ethers.id("INR_CNH"), src.address, dst.address, delivery, signed.encodedQuote, signed.oracleSignature, authSig);
    const dr = await asFacet<any>(d.diamondAddr, "DisputeResolverFacet");
    await expect(dr.disputeSettlement(sid, "client claims wrong amount"))
      .to.emit(dr, "SettlementDisputed");
  });
});
