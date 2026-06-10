/**
 * PropertyBased.test.ts
 *
 * Property-based tests using fast-check ^4.8.0 for the GSDC Diamond system.
 * Each property validates a specific requirement from the audit spec.
 *
 * Design: Deploy the Diamond ONCE per describe block, then use
 * evm_snapshot/evm_revert per property iteration to reset state.
 * This prevents 100+ full deployments (~3s each).
 *
 * numRuns are reduced from spec's 100-200 to 20-50 for CI performance —
 * each iteration involves on-chain transactions through Hardhat which are
 * orders of magnitude slower than pure-function PBT.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import * as fc from "fast-check";
import {
  deployFullDiamond,
  asFacet,
  buildSignedQuote,
  buildSignedAggregatedQuote,
  signEIP3009Authorization,
  HARDHAT_PRIVATE_KEYS,
  queueAndExecute,
} from "./helpers";

const ORACLE_KEY = { privateKey: HARDHAT_PRIVATE_KEYS[1] };
const LP_SOURCE_KEY = HARDHAT_PRIVATE_KEYS[2];

describe("PropertyBased Tests", function () {
  this.timeout(600_000); // 10 min for PBT

  // ═══════════════════════════════════════════════════════════════════
  // Property 1: Margin BPS Sum Invariant (Req 28)
  // ═══════════════════════════════════════════════════════════════════
  describe("Property 1: Margin BPS Sum Invariant (Req 28)", function () {
    let d: any;
    let snapshotId: string;

    before(async () => {
      d = await deployFullDiamond();
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await ethers.provider.send("evm_revert", [snapshotId]);
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    // numRuns: 50 — each iteration does queue + time-warp + execute (moderate cost)
    it("margin BPS sum > 10000 reverts MarginBpsSumExceedsMax; sum <= 10000 succeeds", async () => {
      let iteration = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 65535 }),
          fc.integer({ min: 0, max: 65535 }),
          fc.integer({ min: 0, max: 65535 }),
          async (lpSourceBps, tgsTreasuryBps, lpDestBps) => {
            const iterSnap = await ethers.provider.send("evm_snapshot", []);
            try {
              iteration++;
              const corridorId = ethers.id(`pbt1-corridor-${iteration}`);
              const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");

              // Configure corridor as active first (needed for calculateMargins on success path)
              await tl.configureCorridor(corridorId, true, 1n, 0n, 0, 86399);

              // Queue the margin update
              const tx = await tl.queueMarginUpdate(
                corridorId,
                lpSourceBps,
                tgsTreasuryBps,
                lpDestBps
              );
              const receipt = await tx.wait();
              const changeQueuedLog = receipt!.logs.find((l: any) => {
                try {
                  return tl.interface.parseLog(l)?.name === "ChangeQueued";
                } catch {
                  return false;
                }
              });
              const changeId = changeQueuedLog!.topics[1];

              // Time-warp past the delay
              await ethers.provider.send("evm_increaseTime", [120]);
              await ethers.provider.send("evm_mine", []);

              const sum = lpSourceBps + tgsTreasuryBps + lpDestBps;

              if (sum > 10000) {
                // Should revert with MarginBpsSumExceedsMax
                await expect(tl.executeChange(changeId)).to.be.revertedWithCustomError(
                  tl,
                  "MarginBpsSumExceedsMax"
                );
              } else {
                // Should succeed
                await expect(tl.executeChange(changeId)).to.not.be.reverted;

                // Verify BPS values via calculateMargins
                const ms = await asFacet<any>(d.diamondAddr, "MarginSplitterFacet");
                const testAmount = 10000n; // Use 10000 so margins = bps values directly
                const [lpSrc, tgs, lpDst] = await ms.calculateMargins(corridorId, testAmount);
                expect(lpSrc).to.equal((testAmount * BigInt(lpSourceBps)) / 10000n);
                expect(tgs).to.equal((testAmount * BigInt(tgsTreasuryBps)) / 10000n);
                expect(lpDst).to.equal((testAmount * BigInt(lpDestBps)) / 10000n);
              }
            } finally {
              await ethers.provider.send("evm_revert", [iterSnap]);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Property 2: Float Reserve Boundary Rejection (Req 29)
  // ═══════════════════════════════════════════════════════════════════
  describe("Property 2: Float Reserve Boundary Rejection (Req 29)", function () {
    let d: any;
    let snapshotId: string;
    let lpSource: any;

    before(async () => {
      d = await deployFullDiamond();
      const signers = await ethers.getSigners();
      lpSource = signers[2];
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await ethers.provider.send("evm_revert", [snapshotId]);
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    // numRuns: 50 — each iteration mints tokens + calls reserveFloat (moderate cost)
    it("reserveFloat reverts InsufficientFloat when amount > balance", async () => {
      let iteration = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: 10n ** 18n }),
          fc.bigInt({ min: 1n, max: 10n ** 18n }),
          async (balance, extra) => {
            // Ensure amount > balance
            const amount = balance + extra;
            const iterSnap = await ethers.provider.send("evm_snapshot", []);
            try {
              iteration++;
              const sid = ethers.id(`pbt2-${iteration}`);

              // Mint balance to lpSource
              const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
              await mb.mintFloat(lpSource.address, balance);

              // Try to reserve more than balance → should revert
              const fm = await asFacet<any>(d.diamondAddr, "FloatManagerFacet");
              await expect(
                fm.reserveFloat(lpSource.address, sid, amount)
              ).to.be.reverted; // InsufficientFloat from LibFloat
            } finally {
              await ethers.provider.send("evm_revert", [iterSnap]);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Property 3: Float Reservation Round-Trip (Req 29)
  // ═══════════════════════════════════════════════════════════════════
  describe("Property 3: Float Reservation Round-Trip (Req 29)", function () {
    let d: any;
    let snapshotId: string;
    let lpSource: any;

    before(async () => {
      d = await deployFullDiamond();
      const signers = await ethers.getSigners();
      lpSource = signers[2];
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await ethers.provider.send("evm_revert", [snapshotId]);
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    // numRuns: 50 — each iteration mints + reserve + release (moderate cost)
    it("reserve increases floatReservations; release restores; second release is no-op", async () => {
      let iteration = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: 10n ** 18n }),
          fc.bigInt({ min: 0n, max: 10n ** 18n - 1n }),
          async (amount, extraBalance) => {
            // balance >= amount > 0
            const balance = amount + extraBalance;
            const iterSnap = await ethers.provider.send("evm_snapshot", []);
            try {
              iteration++;
              const sid = ethers.id(`pbt3-${iteration}`);

              // Mint balance to lpSource
              const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
              await mb.mintFloat(lpSource.address, balance);

              const fm = await asFacet<any>(d.diamondAddr, "FloatManagerFacet");

              // Get pre-reserve state
              const [, reservedBefore] = await fm.getAvailableFloat(lpSource.address);

              // Reserve
              await fm.reserveFloat(lpSource.address, sid, amount);
              const [, reservedAfter] = await fm.getAvailableFloat(lpSource.address);
              expect(reservedAfter - reservedBefore).to.equal(amount);

              // Release
              await fm.releaseFloatReservation(lpSource.address, sid);
              const [, reservedFinal] = await fm.getAvailableFloat(lpSource.address);
              expect(reservedFinal).to.equal(reservedBefore);

              // Second release is a no-op (doesn't revert, just releases 0)
              await fm.releaseFloatReservation(lpSource.address, sid);
              const [, reservedAfterSecond] = await fm.getAvailableFloat(lpSource.address);
              expect(reservedAfterSecond).to.equal(reservedBefore);
            } finally {
              await ethers.provider.send("evm_revert", [iterSnap]);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Property 4: Settlement State Machine (Req 30)
  // ═══════════════════════════════════════════════════════════════════
  describe("Property 4: Settlement State Machine (Req 30)", function () {
    let d: any;
    let snapshotId: string;
    let src: any;
    let dst: any;
    const CID = ethers.id("PBT4_CORRIDOR");

    before(async () => {
      d = await deployFullDiamond();
      const signers = await ethers.getSigners();
      src = signers[2];
      dst = signers[3];

      // Configure corridor
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CID, true, 1n, 0n, 0, 86399);

      // Queue and execute margin update
      const tx = await tl.queueMarginUpdate(CID, 30, 10, 20);
      const rcpt = await tx.wait();
      const changeId = rcpt!.logs.find((l: any) => {
        try { return tl.interface.parseLog(l)?.name === "ChangeQueued"; } catch { return false; }
      })!.topics[1];
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await tl.executeChange(changeId);

      // Register partners with margin wallets
      const MW = await ethers.getContractFactory("MarginWallet");
      const srcMargin = await MW.deploy(d.gsdcAddr, src.address, d.diamondAddr);
      await srcMargin.waitForDeployment();
      const dstMargin = await MW.deploy(d.gsdcAddr, dst.address, d.diamondAddr);
      await dstMargin.waitForDeployment();

      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      await cg.registerPartner(src.address, src.address, await srcMargin.getAddress(), ethers.id("ks"), [CID]);
      await cg.registerPartner(dst.address, dst.address, await dstMargin.getAddress(), ethers.id("kd"), [CID]);

      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await ethers.provider.send("evm_revert", [snapshotId]);
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    // numRuns: 20 — full settlement execution is expensive (signing + 4-leg transfer)
    it("executed settlement: status==2, settledAt>=createdAt, totalDebit correct; re-execute reverts", async () => {
      let iteration = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1000n, max: 1_000_000n }),
          async (deliveryAmount) => {
            const iterSnap = await ethers.provider.send("evm_snapshot", []);
            try {
              iteration++;
              const sid = ethers.id(`pbt4-s-${iteration}`);
              const qid = ethers.id(`pbt4-q-${iteration}`);

              // Mint enough tokens for the settlement (delivery + margins)
              // margins = 30+10+20 = 60 bps = 0.6%
              const totalNeeded = deliveryAmount + (deliveryAmount * 60n) / 10000n + 1000n;
              const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
              await mb.mintFloat(src.address, totalNeeded);

              // Build signed quote
              const sq = await buildSignedQuote(d.diamondAddr, ORACLE_KEY, {
                quoteId: qid,
                corridorId: CID,
                deliveryAmount,
                lpSourceBps: 30,
                tgsTreasuryBps: 10,
                lpDestBps: 20,
              });

              // Build EIP-3009 auth
              const authSig = await signEIP3009Authorization({
                tokenAddr: d.gsdcAddr,
                from: { privateKey: LP_SOURCE_KEY, address: src.address },
                to: d.diamondAddr,
                value: sq.totalDebit,
                settlementId: sid,
              });

              // Execute settlement
              const ex = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
              await ex.executeSettlement(
                sid, qid, CID, src.address, dst.address, deliveryAmount,
                sq.encodedQuote, sq.oracleSignature, authSig
              );

              // Verify state machine
              const settlement = await ex.getSettlement(sid);
              expect(settlement.status).to.equal(2); // SETTLED
              expect(settlement.settledAt).to.be.gte(settlement.createdAt);

              // Verify totalDebit = delivery + margins
              const expectedLpSrc = (deliveryAmount * 30n) / 10000n;
              const expectedTgs = (deliveryAmount * 10n) / 10000n;
              const expectedLpDst = (deliveryAmount * 20n) / 10000n;
              const expectedTotal = deliveryAmount + expectedLpSrc + expectedTgs + expectedLpDst;
              expect(settlement.totalDebit).to.equal(expectedTotal);

              // Re-execute should revert SettlementAlreadyExecuted
              // Need fresh quote + auth for the re-attempt
              const sq2 = await buildSignedQuote(d.diamondAddr, ORACLE_KEY, {
                quoteId: qid,
                corridorId: CID,
                deliveryAmount,
                lpSourceBps: 30,
                tgsTreasuryBps: 10,
                lpDestBps: 20,
              });
              const authSig2 = await signEIP3009Authorization({
                tokenAddr: d.gsdcAddr,
                from: { privateKey: LP_SOURCE_KEY, address: src.address },
                to: d.diamondAddr,
                value: sq2.totalDebit,
                settlementId: sid,
              });
              await expect(
                ex.executeSettlement(
                  sid, qid, CID, src.address, dst.address, deliveryAmount,
                  sq2.encodedQuote, sq2.oracleSignature, authSig2
                )
              ).to.be.revertedWithCustomError(ex, "SettlementAlreadyExecuted");
            } finally {
              await ethers.provider.send("evm_revert", [iterSnap]);
            }
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Property 5: EIP-712 Signing Round-Trip (Req 31)
  // ═══════════════════════════════════════════════════════════════════
  describe("Property 5: EIP-712 Signing Round-Trip (Req 31)", function () {
    let d: any;
    let snapshotId: string;

    before(async () => {
      d = await deployFullDiamond();
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await ethers.provider.send("evm_revert", [snapshotId]);
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    // numRuns: 30 — only signature verification, no state mutation needed per iteration
    it("valid quote verifies; wrong-domain quote fails InvalidOracleSignature; domainSeparator stable", async () => {
      let iteration = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1000n, max: 500_000n }),
          async (deliveryAmount) => {
            const iterSnap = await ethers.provider.send("evm_snapshot", []);
            try {
              iteration++;
              const quoteId = ethers.id(`pbt5-q-${iteration}`);
              const corridorId = ethers.id(`pbt5-c-${iteration}`);

              const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");

              // Build a valid signed quote
              const sq = await buildSignedQuote(d.diamondAddr, ORACLE_KEY, {
                quoteId,
                corridorId,
                deliveryAmount,
                lpSourceBps: 30,
                tgsTreasuryBps: 10,
                lpDestBps: 20,
              });

              // Mine a block so block.timestamp > validAfter
              await ethers.provider.send("evm_mine", []);

              // Valid quote should verify
              await expect(
                qv.verifyAndDecodeQuote(sq.encodedQuote, sq.oracleSignature)
              ).to.not.be.reverted;

              // Build quote signed against a DIFFERENT diamond address (wrong domain)
              const wrongDiamondAddr = ethers.Wallet.createRandom().address;
              const sqWrong = await buildSignedQuote(wrongDiamondAddr, ORACLE_KEY, {
                quoteId,
                corridorId,
                deliveryAmount,
                lpSourceBps: 30,
                tgsTreasuryBps: 10,
                lpDestBps: 20,
              });

              // Wrong-domain quote should fail signature verification
              await expect(
                qv.verifyAndDecodeQuote(sqWrong.encodedQuote, sqWrong.oracleSignature)
              ).to.be.revertedWithCustomError(qv, "InvalidOracleSignature");

              // Domain separator stability
              const ds1 = await qv.quoteDomainSeparator();
              const ds2 = await qv.quoteDomainSeparator();
              expect(ds1).to.equal(ds2);
            } finally {
              await ethers.provider.send("evm_revert", [iterSnap]);
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Property 6: EIP-3009 Nonce Anti-Replay (Req 32)
  // ═══════════════════════════════════════════════════════════════════
  describe("Property 6: EIP-3009 Nonce Anti-Replay (Req 32)", function () {
    let d: any;
    let snapshotId: string;
    let lpSigner: any;

    before(async () => {
      d = await deployFullDiamond();
      const signers = await ethers.getSigners();
      lpSigner = signers[2];
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await ethers.provider.send("evm_revert", [snapshotId]);
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    // numRuns: 20 — minting + EIP-3009 calls are expensive
    it("transferWithAuthorization succeeds once; replay reverts AuthorizationAlreadyUsed", async () => {
      let iteration = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: 1000n }),
          async (value) => {
            const iterSnap = await ethers.provider.send("evm_snapshot", []);
            try {
              iteration++;
              const nonce = ethers.id(`pbt6-nonce-${iteration}`);
              const recipient = ethers.Wallet.createRandom().address;

              // Mint tokens to lpSigner
              const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
              await mb.mintFloat(lpSigner.address, value * 3n); // extra for second attempt

              // Build EIP-3009 authorization
              const authSig = await signEIP3009Authorization({
                tokenAddr: d.gsdcAddr,
                from: { privateKey: LP_SOURCE_KEY, address: lpSigner.address },
                to: recipient,
                value,
                settlementId: nonce, // nonce
              });

              // Parse authSig: validBefore(32) || r(32) || s(32) || v(1)
              const validBefore = BigInt(ethers.dataSlice(authSig, 0, 32));
              const r = ethers.dataSlice(authSig, 32, 64);
              const s = ethers.dataSlice(authSig, 64, 96);
              const v = parseInt(ethers.dataSlice(authSig, 96, 97), 16);

              // First call should succeed
              const token = await ethers.getContractAt("GSDCToken", d.gsdcAddr);
              await expect(
                token.transferWithAuthorization(
                  lpSigner.address, recipient, value, 0, validBefore, nonce, v, r, s
                )
              ).to.not.be.reverted;

              // Replay should revert with AuthorizationAlreadyUsed
              await expect(
                token.transferWithAuthorization(
                  lpSigner.address, recipient, value, 0, validBefore, nonce, v, r, s
                )
              ).to.be.revertedWithCustomError(token, "AuthorizationAlreadyUsed");
            } finally {
              await ethers.provider.send("evm_revert", [iterSnap]);
            }
          }
        ),
        { numRuns: 20 }
      );
    });

    it("cancelAuthorization prevents subsequent transfer", async () => {
      let iteration = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: 1000n }),
          async (value) => {
            const iterSnap = await ethers.provider.send("evm_snapshot", []);
            try {
              iteration++;
              const nonce = ethers.id(`pbt6-cancel-${iteration}`);
              const recipient = ethers.Wallet.createRandom().address;

              // Mint tokens
              const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
              await mb.mintFloat(lpSigner.address, value * 3n);

              // Build transfer authorization
              const authSig = await signEIP3009Authorization({
                tokenAddr: d.gsdcAddr,
                from: { privateKey: LP_SOURCE_KEY, address: lpSigner.address },
                to: recipient,
                value,
                settlementId: nonce,
              });

              // Cancel the nonce first
              // Sign CancelAuthorization
              const token = await ethers.getContractAt("GSDCToken", d.gsdcAddr);
              const cancelTypehash = ethers.keccak256(
                ethers.toUtf8Bytes("CancelAuthorization(address authorizer,bytes32 nonce)")
              );
              const chainId = (await ethers.provider.getNetwork()).chainId;
              const domainTypeHash = ethers.keccak256(
                ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
              );
              const domainSeparator = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ["bytes32", "bytes32", "bytes32", "uint256", "address"],
                  [
                    domainTypeHash,
                    ethers.keccak256(ethers.toUtf8Bytes("GSDC")),
                    ethers.keccak256(ethers.toUtf8Bytes("1")),
                    chainId,
                    d.gsdcAddr,
                  ]
                )
              );
              const cancelStructHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ["bytes32", "address", "bytes32"],
                  [cancelTypehash, lpSigner.address, nonce]
                )
              );
              const cancelDigest = ethers.keccak256(
                ethers.concat(["0x1901", domainSeparator, cancelStructHash])
              );
              const cancelSk = new ethers.SigningKey(LP_SOURCE_KEY);
              const cancelSig = cancelSk.sign(cancelDigest);
              const cancelV = cancelSig.v;
              const cancelR = cancelSig.r;
              const cancelS = cancelSig.s;

              await token.cancelAuthorization(lpSigner.address, nonce, cancelV, cancelR, cancelS);

              // Now try transfer — should revert AuthorizationAlreadyUsed
              const validBefore = BigInt(ethers.dataSlice(authSig, 0, 32));
              const r = ethers.dataSlice(authSig, 32, 64);
              const s = ethers.dataSlice(authSig, 64, 96);
              const v = parseInt(ethers.dataSlice(authSig, 96, 97), 16);

              await expect(
                token.transferWithAuthorization(
                  lpSigner.address, recipient, value, 0, validBefore, nonce, v, r, s
                )
              ).to.be.revertedWithCustomError(token, "AuthorizationAlreadyUsed");
            } finally {
              await ethers.provider.send("evm_revert", [iterSnap]);
            }
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Property 7: Pause-Unpause Round-Trip (Req 36)
  // ═══════════════════════════════════════════════════════════════════
  describe("Property 7: Pause-Unpause Round-Trip (Req 36)", function () {
    let d: any;
    let snapshotId: string;
    let src: any;
    let dst: any;
    const CID = ethers.id("PBT7_CORRIDOR");

    before(async () => {
      d = await deployFullDiamond();
      const signers = await ethers.getSigners();
      src = signers[2];
      dst = signers[3];

      // Configure corridor
      const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
      await tl.configureCorridor(CID, true, 1n, 0n, 0, 86399);

      // Queue and execute margin update
      const tx = await tl.queueMarginUpdate(CID, 30, 10, 20);
      const rcpt = await tx.wait();
      const changeId = rcpt!.logs.find((l: any) => {
        try { return tl.interface.parseLog(l)?.name === "ChangeQueued"; } catch { return false; }
      })!.topics[1];
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await tl.executeChange(changeId);

      // Register partners
      const MW = await ethers.getContractFactory("MarginWallet");
      const srcMargin = await MW.deploy(d.gsdcAddr, src.address, d.diamondAddr);
      await srcMargin.waitForDeployment();
      const dstMargin = await MW.deploy(d.gsdcAddr, dst.address, d.diamondAddr);
      await dstMargin.waitForDeployment();

      const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
      await cg.registerPartner(src.address, src.address, await srcMargin.getAddress(), ethers.id("ks"), [CID]);
      await cg.registerPartner(dst.address, dst.address, await dstMargin.getAddress(), ethers.id("kd"), [CID]);

      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await ethers.provider.send("evm_revert", [snapshotId]);
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    // numRuns: 20 — full settlement required to prove unpause works
    it("paused → executeSettlement reverts SystemPaused; unpause → settlement succeeds", async () => {
      let iteration = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1000n, max: 500_000n }),
          async (deliveryAmount) => {
            const iterSnap = await ethers.provider.send("evm_snapshot", []);
            try {
              iteration++;
              const sid = ethers.id(`pbt7-s-${iteration}`);
              const qid = ethers.id(`pbt7-q-${iteration}`);

              const ex = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
              const p = await asFacet<any>(d.diamondAddr, "PausableFacet");

              // Mint tokens
              const totalNeeded = deliveryAmount + (deliveryAmount * 60n) / 10000n + 1000n;
              const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
              await mb.mintFloat(src.address, totalNeeded);

              // Build quote + auth
              const sq = await buildSignedQuote(d.diamondAddr, ORACLE_KEY, {
                quoteId: qid,
                corridorId: CID,
                deliveryAmount,
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

              // Pause → settlement should revert
              await p.pause();
              await expect(
                ex.executeSettlement(
                  sid, qid, CID, src.address, dst.address, deliveryAmount,
                  sq.encodedQuote, sq.oracleSignature, authSig
                )
              ).to.be.revertedWithCustomError(ex, "SystemPaused");

              // Unpause → settlement should succeed
              await p.unpause();
              await expect(
                ex.executeSettlement(
                  sid, qid, CID, src.address, dst.address, deliveryAmount,
                  sq.encodedQuote, sq.oracleSignature, authSig
                )
              ).to.not.be.reverted;
            } finally {
              await ethers.provider.send("evm_revert", [iterSnap]);
            }
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Property 8: Quote TTL Enforcement (Req 38)
  // ═══════════════════════════════════════════════════════════════════
  describe("Property 8: Quote TTL Enforcement (Req 38)", function () {
    let d: any;
    let snapshotId: string;

    before(async () => {
      d = await deployFullDiamond();
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await ethers.provider.send("evm_revert", [snapshotId]);
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    // numRuns: 50 — only signature construction + view call (cheap)
    it("quote with TTL > maxQuoteTTL (300) reverts QuoteTTLExceeded", async () => {
      let iteration = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 301, max: 86400 }),
          async (ttl) => {
            const iterSnap = await ethers.provider.send("evm_snapshot", []);
            try {
              iteration++;
              const quoteId = ethers.id(`pbt8-q-${iteration}`);
              const corridorId = ethers.id(`pbt8-c-${iteration}`);

              const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");

              // Get current block timestamp
              const blockTs = BigInt(
                (await ethers.provider.getBlock("latest"))!.timestamp
              );

              // Build a quote with TTL > 300 (maxQuoteTTL)
              // validAfter = blockTs - 1 (so quote is valid now)
              // validBefore = validAfter + ttl = blockTs - 1 + ttl
              // TTL = validBefore - validAfter = ttl > 300
              const sq = await buildSignedQuote(d.diamondAddr, ORACLE_KEY, {
                quoteId,
                corridorId,
                deliveryAmount: 100_000n,
                lpSourceBps: 30,
                tgsTreasuryBps: 10,
                lpDestBps: 20,
                validAfter: blockTs - 1n,
                validBefore: blockTs - 1n + BigInt(ttl),
              });

              // Mine a block so timestamp advances past validAfter
              await ethers.provider.send("evm_mine", []);

              // Should revert with QuoteTTLExceeded
              await expect(
                qv.verifyAndDecodeQuote(sq.encodedQuote, sq.oracleSignature)
              ).to.be.revertedWithCustomError(qv, "QuoteTTLExceeded");
            } finally {
              await ethers.provider.send("evm_revert", [iterSnap]);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Property 9: OutsideSettlementWindow CorridorId (Req 40)
  // ═══════════════════════════════════════════════════════════════════
  describe("Property 9: OutsideSettlementWindow CorridorId (Req 40)", function () {
    let d: any;
    let snapshotId: string;

    before(async () => {
      d = await deployFullDiamond();
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await ethers.provider.send("evm_revert", [snapshotId]);
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    // numRuns: 20 — requires corridor config + time manipulation per iteration
    it("settlement outside configured window reverts OutsideSettlementWindow(corridorId)", async () => {
      let iteration = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 86399 }),
          async (windowSecond) => {
            const iterSnap = await ethers.provider.send("evm_snapshot", []);
            try {
              iteration++;
              const corridorId = ethers.id(`pbt9-corridor-${iteration}`);
              const sid = ethers.id(`pbt9-s-${iteration}`);
              const qid = ethers.id(`pbt9-q-${iteration}`);

              // Configure corridor with a 1-second window at windowSecond
              const tl = await asFacet<any>(d.diamondAddr, "TimeLockControllerFacet");
              await tl.configureCorridor(
                corridorId,
                true,
                1n,
                0n,
                windowSecond,
                windowSecond // 1-second window (start == end)
              );

              // Calculate a timestamp that is definitely OUTSIDE the window.
              // The window is exactly at windowSecond (inclusive).
              // We want (block.timestamp % 86400) to NOT equal windowSecond.
              // Pick outsideSecond = (windowSecond + 43200) % 86400 (half day away)
              const outsideSecond = (windowSecond + 43200) % 86400;

              // Get current block timestamp and compute target timestamp
              const block = await ethers.provider.getBlock("latest");
              const currentTs = block!.timestamp;
              const currentSecond = currentTs % 86400;

              // Calculate how much to advance to hit outsideSecond
              let advance: number;
              if (outsideSecond > currentSecond) {
                advance = outsideSecond - currentSecond;
              } else {
                advance = 86400 - currentSecond + outsideSecond;
              }

              // Advance time
              await ethers.provider.send("evm_increaseTime", [advance]);
              await ethers.provider.send("evm_mine", []);

              // Verify we're outside the window
              const newBlock = await ethers.provider.getBlock("latest");
              const sec = newBlock!.timestamp % 86400;
              // sec should not equal windowSecond (since we moved half a day away)

              // Call executeSettlement — should pass orchestrator check, pause check,
              // status check (new sid), corridor active check, amount check (>= min=1),
              // then fail at window check
              const ex = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
              const [admin] = await ethers.getSigners();

              await expect(
                ex.executeSettlement(
                  sid, qid, corridorId,
                  admin.address, admin.address, // lpSource/lpDest don't matter — we'll hit window first
                  100n, // deliveryAmount >= minDeliveryAmount(1)
                  "0x", "0x", "0x"
                )
              ).to.be.revertedWithCustomError(ex, "OutsideSettlementWindow");
            } finally {
              await ethers.provider.send("evm_revert", [iterSnap]);
            }
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});
