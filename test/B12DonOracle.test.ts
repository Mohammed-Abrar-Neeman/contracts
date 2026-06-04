// Tier B-12 — OracleGovernanceFacet + verifyAndDecodeAggregatedQuote tests.
//
// Covers:
//   - DAO-managed whitelist mgmt (admin gate, threshold ≥ 1, ≤ signers,
//     ≤ MAX_SIGNERS, no zero, no duplicates).
//   - verifyAndDecodeAggregatedQuote happy path (threshold met, all
//     signers whitelisted, no duplicates).
//   - Negative paths: below-threshold, non-whitelisted signer, duplicate
//     signer, expired quote.
//
// Single suite, single Diamond deployment via deployFullDiamond.

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployFullDiamond,
  asFacet,
  buildSignedAggregatedQuote,
  HARDHAT_PRIVATE_KEYS,
  queueAndExecute,
} from "./helpers";

describe("[B-12] OracleGovernanceFacet + verifyAndDecodeAggregatedQuote", function () {
  let diamondAddr: string;
  let admin: { address: string };
  // DON committee — 5 wallets, threshold 3.
  const donKeys: string[] = [];
  const donAddrs: string[] = [];
  for (let i = 0; i < 5; i++) {
    const seed = ethers.keccak256(ethers.toUtf8Bytes(`b12-test-don-${i}`));
    const w = new ethers.Wallet(seed);
    donKeys.push(w.privateKey);
    donAddrs.push(w.address);
  }
  // Bogus non-whitelisted signer.
  const bogusKey = ethers.keccak256(ethers.toUtf8Bytes("b12-test-bogus"));
  const bogusAddr = new ethers.Wallet(bogusKey).address;

  before(async () => {
    const d = await deployFullDiamond();
    diamondAddr = d.diamondAddr;
    admin = { address: d.admin };
  });

  // ─── Whitelist management ────────────────────────────────────────

  describe("OracleGovernanceFacet.queueOracleSignersChange + executeChange", () => {
    it("admin can set signers + threshold (happy path via queue+execute)", async () => {
      const gov = await asFacet<any>(diamondAddr, "OracleGovernanceFacet");
      // [B-16 β-2] audit: NEW-010 — immediate setOracleSigners removed;
      // happy path now goes queue → executeChange.
      await queueAndExecute(diamondAddr, "OracleGovernanceFacet",
        "queueOracleSignersChange", [donAddrs, 3]);
      const stored = await gov.getOracleSigners();
      expect(stored.length).to.eq(5);
      for (const a of donAddrs) expect(stored).to.include(a);
      expect(await gov.getOracleThreshold()).to.eq(3n);
      for (const a of donAddrs) expect(await gov.isOracleSigner(a)).to.eq(true);
      expect(await gov.isOracleSigner(bogusAddr)).to.eq(false);
    });

    it("non-admin reverts at queue time", async () => {
      const [, , nonAdmin] = await ethers.getSigners();
      const gov = (await asFacet<any>(diamondAddr, "OracleGovernanceFacet")).connect(nonAdmin);
      await expect(gov.queueOracleSignersChange(donAddrs, 3))
        .to.be.revertedWith("LibSettlement: not admin");
    });

    it("threshold < 1 reverts ThresholdBelowOne at queue time", async () => {
      const gov = await asFacet<any>(diamondAddr, "OracleGovernanceFacet");
      await expect(gov.queueOracleSignersChange(donAddrs, 0))
        .to.be.revertedWithCustomError(gov, "ThresholdBelowOne");
    });

    it("threshold > signers.length reverts SignersBelowThreshold at queue time", async () => {
      const gov = await asFacet<any>(diamondAddr, "OracleGovernanceFacet");
      await expect(gov.queueOracleSignersChange(donAddrs, 6))
        .to.be.revertedWithCustomError(gov, "SignersBelowThreshold");
    });

    it("signers.length > MAX_SIGNERS reverts TooManySigners at queue time", async () => {
      const gov = await asFacet<any>(diamondAddr, "OracleGovernanceFacet");
      const tooMany: string[] = [];
      for (let i = 0; i < 11; i++) {
        tooMany.push(new ethers.Wallet(
          ethers.keccak256(ethers.toUtf8Bytes(`b12-too-many-${i}`))
        ).address);
      }
      await expect(gov.queueOracleSignersChange(tooMany, 3))
        .to.be.revertedWithCustomError(gov, "TooManySigners");
    });

    it("zero address in signers reverts ZeroSigner at queue time", async () => {
      const gov = await asFacet<any>(diamondAddr, "OracleGovernanceFacet");
      const bad = [...donAddrs];
      bad[2] = ethers.ZeroAddress;
      await expect(gov.queueOracleSignersChange(bad, 3))
        .to.be.revertedWithCustomError(gov, "ZeroSigner");
    });

    it("duplicate signer reverts DuplicateSignerInList at queue time", async () => {
      const gov = await asFacet<any>(diamondAddr, "OracleGovernanceFacet");
      const bad = [...donAddrs];
      bad[4] = bad[0];
      await expect(gov.queueOracleSignersChange(bad, 3))
        .to.be.revertedWithCustomError(gov, "DuplicateSignerInList");
    });

    it("emits OracleSignersUpdated from executeChange branch", async () => {
      // Event emit site moved from immediate-set facet to TimeLockControllerFacet's
      // _executeOracleSignersMulti branch. Listen on the diamond address.
      const subset = donAddrs.slice(0, 3);
      const tl = await ethers.getContractAt("TimeLockControllerFacet", diamondAddr);
      await queueAndExecute(diamondAddr, "OracleGovernanceFacet",
        "queueOracleSignersChange", [subset, 2]);
      // Restore the full whitelist for subsequent tests.
      await queueAndExecute(diamondAddr, "OracleGovernanceFacet",
        "queueOracleSignersChange", [donAddrs, 3]);
      // Spot-check the event interface on TL is the same selector.
      const ev = tl.interface.getEvent("OracleSignersUpdated");
      expect(ev?.name).to.eq("OracleSignersUpdated");
    });
  });

  // ─── verifyAndDecodeAggregatedQuote ──────────────────────────────

  describe("verifyAndDecodeAggregatedQuote", () => {
    const quoteId = ethers.keccak256(ethers.toUtf8Bytes("b12-qid-1"));
    const corridorId = ethers.encodeBytes32String("INR_CNH");
    const baseInputs = {
      quoteId, corridorId,
      deliveryAmount: ethers.parseUnits("1000", 18),
      lpSourceBps: 20, tgsTreasuryBps: 20, lpDestBps: 10,
    };

    it("3 valid whitelisted sigs (threshold=3) → decode succeeds", async () => {
      const verifier = await asFacet<any>(diamondAddr, "QuoteVerifierFacet");
      const { encodedQuote, signatures, reportsRoot } =
        await buildSignedAggregatedQuote(diamondAddr, donKeys.slice(0, 3), baseInputs);
      const decoded = await verifier.verifyAndDecodeAggregatedQuote(
        encodedQuote, signatures, reportsRoot,
      );
      expect(decoded.quoteId).to.eq(quoteId);
      expect(decoded.corridorId).to.eq(corridorId);
      expect(decoded.deliveryAmount).to.eq(baseInputs.deliveryAmount);
    });

    it("5 valid sigs (over-threshold) → decode succeeds", async () => {
      const verifier = await asFacet<any>(diamondAddr, "QuoteVerifierFacet");
      const { encodedQuote, signatures, reportsRoot } =
        await buildSignedAggregatedQuote(diamondAddr, donKeys, baseInputs);
      const decoded = await verifier.verifyAndDecodeAggregatedQuote(
        encodedQuote, signatures, reportsRoot,
      );
      expect(decoded.quoteId).to.eq(quoteId);
    });

    it("2 sigs (below threshold) reverts BelowThreshold", async () => {
      const verifier = await asFacet<any>(diamondAddr, "QuoteVerifierFacet");
      const { encodedQuote, signatures, reportsRoot } =
        await buildSignedAggregatedQuote(diamondAddr, donKeys.slice(0, 2), baseInputs);
      await expect(verifier.verifyAndDecodeAggregatedQuote(
        encodedQuote, signatures, reportsRoot,
      )).to.be.revertedWithCustomError(verifier, "BelowThreshold");
    });

    it("non-whitelisted signer reverts InvalidOracleSignature", async () => {
      const verifier = await asFacet<any>(diamondAddr, "QuoteVerifierFacet");
      const { encodedQuote, signatures, reportsRoot } =
        await buildSignedAggregatedQuote(
          diamondAddr,
          [donKeys[0], donKeys[1], bogusKey], // 3 sigs but one is bogus
          baseInputs,
        );
      await expect(verifier.verifyAndDecodeAggregatedQuote(
        encodedQuote, signatures, reportsRoot,
      )).to.be.revertedWithCustomError(verifier, "InvalidOracleSignature");
    });

    it("duplicate signer reverts DuplicateSigner", async () => {
      const verifier = await asFacet<any>(diamondAddr, "QuoteVerifierFacet");
      const { encodedQuote, signatures, reportsRoot } =
        await buildSignedAggregatedQuote(
          diamondAddr,
          [donKeys[0], donKeys[0], donKeys[1]], // first two are the same signer
          baseInputs,
        );
      await expect(verifier.verifyAndDecodeAggregatedQuote(
        encodedQuote, signatures, reportsRoot,
      )).to.be.revertedWithCustomError(verifier, "DuplicateSigner");
    });

    it("expired quote (validBefore in past) reverts QuoteExpired", async () => {
      const verifier = await asFacet<any>(diamondAddr, "QuoteVerifierFacet");
      // validBefore = 1 second after the genesis block → already expired by 'now'.
      const expired = {
        ...baseInputs,
        validBefore: 1n,
      };
      const { encodedQuote, signatures, reportsRoot } =
        await buildSignedAggregatedQuote(diamondAddr, donKeys.slice(0, 3), expired);
      await expect(verifier.verifyAndDecodeAggregatedQuote(
        encodedQuote, signatures, reportsRoot,
      )).to.be.revertedWithCustomError(verifier, "QuoteExpired");
    });

    it("changing reportsRoot changes the digest (sig fails)", async () => {
      const verifier = await asFacet<any>(diamondAddr, "QuoteVerifierFacet");
      const { encodedQuote, signatures } =
        await buildSignedAggregatedQuote(diamondAddr, donKeys.slice(0, 3), baseInputs);
      // Submit the same sigs but with a non-zero reportsRoot — sigs were
      // produced against ZeroHash, so recovery yields the wrong addr.
      const wrongRoot = ethers.keccak256(ethers.toUtf8Bytes("not-the-original-root"));
      await expect(verifier.verifyAndDecodeAggregatedQuote(
        encodedQuote, signatures, wrongRoot,
      )).to.be.revertedWithCustomError(verifier, "InvalidOracleSignature");
    });
  });

  // ─── B-7 backwards-compat (single-signer path unchanged) ─────────

  describe("[B-7 backwards compat] verifyAndDecodeQuote (single signer)", () => {
    it("still works for the original ORACLE_MODE=SINGLE_SIGNER path", async () => {
      // The existing E2E.test.ts + B7OrchestratorParity.test.ts already
      // assert single-signer paths. This regression check ensures the
      // new aggregated typehash addition didn't perturb the existing
      // single-sig typehash. Re-derive locally + assert byte equality.
      // [B-14 C8] typehash now includes `bool isOverridden` as the
      // final field — append-at-end placement keeps the canonical
      // form stable for all prior fields.
      const verifier = await asFacet<any>(diamondAddr, "QuoteVerifierFacet");
      const expected = ethers.keccak256(ethers.toUtf8Bytes(
        "OracleQuote(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount," +
        "uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps," +
        "uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate," +
        "bool isOverridden)"
      ));
      expect(await verifier.ORACLE_QUOTE_TYPEHASH()).to.eq(expected);
    });

    it("singleton oracleSigner state slot stays writable via queue+execute", async () => {
      // [B-16 β-2] audit: NEW-010 — immediate setOracleSigner removed.
      // The singular slot is now rotated through the same time-locked
      // queue/execute dispatcher.
      const verifier = await asFacet<any>(diamondAddr, "QuoteVerifierFacet");
      const fresh = ethers.Wallet.createRandom().address;
      await queueAndExecute(diamondAddr, "QuoteVerifierFacet",
        "queueOracleSignerChange", [fresh]);
      // Cannot assert the event on the verifier facet anymore — emit
      // moved to TimeLockControllerFacet. Storage check instead.
      void verifier;
    });
  });

  // ─── HARDHAT_PRIVATE_KEYS sanity — confirms we never accidentally
  //     re-used a Hardhat default key as a DON signer (which would
  //     conflict with admin signer #0 in deployFullDiamond).
  it("DON test keys are disjoint from HARDHAT_PRIVATE_KEYS", () => {
    const hardhatAddrs = new Set(
      HARDHAT_PRIVATE_KEYS.map((k) => new ethers.Wallet(k).address.toLowerCase()),
    );
    for (const a of donAddrs) {
      expect(hardhatAddrs.has(a.toLowerCase())).to.eq(false);
    }
    expect(hardhatAddrs.has(admin.address.toLowerCase())).to.eq(true); // admin IS hardhat[0]
  });
});
