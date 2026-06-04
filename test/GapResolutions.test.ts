// Tests for B-5 [GAP #1 + #2] resolutions, updated for B-6 [CARRY-CRITICAL]
// bypass removal:
//   #1 Domain consistency (unchanged): QuoteVerifierFacet.quoteDomainSeparator()
//      must match what an off-chain client building EIP-712 with
//      name="GSDCOracle" version="1" would produce.
//   #2 SettlementExecutorFacet now performs MANDATORY cross-facet quote
//      verify and EIP-3009 redemption (no empty-bypass branch). The new
//      check order is: pre-conditions (corridor / amount / window /
//      partner) → quote verify → EIP-3009 redeem → fan-out.

import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFullDiamond, asFacet, buildSignedQuote, signEIP3009Authorization, HARDHAT_PRIVATE_KEYS } from "./helpers";

const CORRIDOR_ID = ethers.id("INR_CNH");

describe("[GAP #1] QuoteVerifierFacet — domain GSDCOracle/1 matches OZ EIP712", () => {
  it("quoteDomainSeparator() matches the externally-computed EIP-712 domain", async () => {
    const d = await deployFullDiamond();
    const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
    const onChain = await qv.quoteDomainSeparator();

    const domainTypeHash = ethers.keccak256(ethers.toUtf8Bytes(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    ));
    const expected = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32","bytes32","bytes32","uint256","address"],
      [domainTypeHash,
        ethers.keccak256(ethers.toUtf8Bytes("GSDCOracle")),
        ethers.keccak256(ethers.toUtf8Bytes("1")),
        (await ethers.provider.getNetwork()).chainId,
        d.diamondAddr],
    ));
    expect(onChain).to.equal(expected);
  });
});

describe("[GAP #2 + B-6 CARRY-CRITICAL] SettlementExecutor — mandatory verify + EIP-3009", () => {
  // d.oracleSigner is hardhat signer #1 → use HARDHAT_PRIVATE_KEYS[1].
  const ORACLE_PK = { privateKey: HARDHAT_PRIVATE_KEYS[1] };
  const SRC_PK = HARDHAT_PRIVATE_KEYS[2];

  async function setupFullPath() {
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

    return { d, src, dst };
  }

  it("happy path: valid signed quote + EIP-3009 auth — emits SettlementExecuted", async () => {
    const { d, src, dst } = await setupFullPath();
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const delivery = ethers.parseEther("100");
    const totalDebit = delivery + (delivery * 60n) / 10_000n;
    await mb.mintFloat(src.address, totalDebit);

    const sid = ethers.id("s-gap2-happy");
    const qid = ethers.id("q-gap2-happy");
    const signed = await buildSignedQuote(d.diamondAddr, ORACLE_PK, {
      quoteId: qid, corridorId: CORRIDOR_ID, deliveryAmount: delivery,
      lpSourceBps: 30, tgsTreasuryBps: 10, lpDestBps: 20,
    });
    const authSig = await signEIP3009Authorization({
      tokenAddr: d.gsdcAddr,
      from: { privateKey: SRC_PK, address: src.address },
      to: d.diamondAddr, value: signed.totalDebit, settlementId: sid,
    });
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    await expect(exec.executeSettlement(
      sid, qid, CORRIDOR_ID, src.address, dst.address, delivery,
      signed.encodedQuote, signed.oracleSignature, authSig,
    )).to.emit(exec, "SettlementExecuted");
  });

  it("cross-corridor replay rejected — submitted corridor inactive reverts CorridorNotActive first", async () => {
    // [B-6] After the check reorder, a corridor mismatch where the
    // submitted corridor is inactive reverts at the pre-verify
    // CorridorNotActive gate before the quote-vs-corridor mismatch
    // check is even reached. This still proves the on-chain refusal.
    const { d, src, dst } = await setupFullPath();
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    const signed = await buildSignedQuote(d.diamondAddr, ORACLE_PK, {
      quoteId: ethers.id("q-cross"), corridorId: CORRIDOR_ID, deliveryAmount: 100n,
      lpSourceBps: 30, tgsTreasuryBps: 10, lpDestBps: 20,
    });
    const otherCorridor = ethers.id("BRL_CNH"); // never configured → not active.
    await expect(exec.executeSettlement(
      ethers.id("s-cross"), ethers.id("q-cross"), otherCorridor,
      src.address, dst.address, 100n,
      signed.encodedQuote, signed.oracleSignature, "0x" + "00".repeat(97),
    )).to.be.revertedWithCustomError(exec, "CorridorNotActive");
  });

  it("quoteId mismatch within an active corridor → QuoteCorridorMismatch", async () => {
    const { d, src, dst } = await setupFullPath();
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    const sid = ethers.id("s-mismatch");
    const signed = await buildSignedQuote(d.diamondAddr, ORACLE_PK, {
      quoteId: ethers.id("q-real"), corridorId: CORRIDOR_ID, deliveryAmount: 100n,
      lpSourceBps: 30, tgsTreasuryBps: 10, lpDestBps: 20,
    });
    const authSig = await signEIP3009Authorization({
      tokenAddr: d.gsdcAddr,
      from: { privateKey: SRC_PK, address: src.address },
      to: d.diamondAddr, value: signed.totalDebit, settlementId: sid,
    });
    await expect(exec.executeSettlement(
      sid, ethers.id("q-imposter"), CORRIDOR_ID, src.address, dst.address, 100n,
      signed.encodedQuote, signed.oracleSignature, authSig,
    )).to.be.revertedWithCustomError(exec, "QuoteCorridorMismatch");
  });

  it("expired quote bubbles QuoteExpired from the verifier facet", async () => {
    const { d, src, dst } = await setupFullPath();
    const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    const signed = await buildSignedQuote(d.diamondAddr, ORACLE_PK, {
      quoteId: ethers.id("q-exp"), corridorId: CORRIDOR_ID, deliveryAmount: 1n,
      lpSourceBps: 30, tgsTreasuryBps: 10, lpDestBps: 20,
      validBefore: 1n,
      midRate: "1",
    });
    await expect(exec.executeSettlement(
      ethers.id("s-exp"), ethers.id("q-exp"), CORRIDOR_ID, src.address, dst.address, 1n,
      signed.encodedQuote, signed.oracleSignature, "0x" + "00".repeat(97),
    )).to.be.revertedWithCustomError(qv, "QuoteExpired");
  });

  it("malformed authorizationSig (wrong length) rejected", async () => {
    const { d, src, dst } = await setupFullPath();
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const delivery = 1n;
    await mb.mintFloat(src.address, ethers.parseEther("1"));
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    const sid = ethers.id("s-bad-auth");
    const signed = await buildSignedQuote(d.diamondAddr, ORACLE_PK, {
      quoteId: ethers.id("q-bad-auth"), corridorId: CORRIDOR_ID, deliveryAmount: delivery,
      lpSourceBps: 30, tgsTreasuryBps: 10, lpDestBps: 20,
    });
    // 32-byte sig (wrong length, should be 65).
    await expect(exec.executeSettlement(
      sid, ethers.id("q-bad-auth"), CORRIDOR_ID, src.address, dst.address, delivery,
      signed.encodedQuote, signed.oracleSignature, ethers.id("not-a-65-byte-sig"),
    )).to.be.revertedWithCustomError(exec, "InvalidAuthorizationSig");
  });
});
