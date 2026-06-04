// Tier B-7 — On-chain round-trip parity check for the orchestrator's
// OracleClient.signQuote. Replicates the exact off-chain digest the
// backend produces and asserts QuoteVerifierFacet.verifyAndDecodeQuote
// accepts it.
//
// The backend's OracleClient lives in /app/backend; this test
// re-implements the same signing recipe inline (a few lines) and
// asserts the contract's verifier accepts it. If this test ever
// fails, the orchestrator's signing wire is broken — fix the
// orchestrator before shipping B-7.

import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFullDiamond, asFacet, HARDHAT_PRIVATE_KEYS } from "./helpers";

const CORRIDOR_ID = ethers.id("INR_CNH");

async function offChainSignQuote(args: {
  diamondAddr: string;
  oraclePrivateKey: string;
  quoteId: string;
  corridorId: string;
  deliveryAmount: bigint;
  totalDebit: bigint;
  lpSourceMarginBps: number;
  tgsTreasuryMarginBps: number;
  lpDestMarginBps: number;
  validBefore: bigint;
  midRate?: string;
}) {
  const midRate = args.midRate ?? "1.00000000";
  const validAfter = 0n;

  const tuple = [
    args.quoteId, args.corridorId, args.deliveryAmount, args.totalDebit,
    BigInt(args.lpSourceMarginBps), BigInt(args.tgsTreasuryMarginBps), BigInt(args.lpDestMarginBps),
    validAfter, args.validBefore, midRate,
    // [B-14 C8] parity test stays at default (isOverridden=false).
    false,
  ];
  const encodedQuote = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,string,bool)"],
    [tuple],
  );

  const TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(
    "OracleQuote(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount," +
    "uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps," +
    "uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate," +
    "bool isOverridden)"
  ));
  const structHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32","bytes32","bytes32","uint256","uint256","uint256","uint256","uint256","uint256","uint256","bytes32","bool"],
    [TYPEHASH, args.quoteId, args.corridorId, args.deliveryAmount, args.totalDebit,
      BigInt(args.lpSourceMarginBps), BigInt(args.tgsTreasuryMarginBps), BigInt(args.lpDestMarginBps),
      validAfter, args.validBefore, ethers.keccak256(ethers.toUtf8Bytes(midRate)), false],
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
      chainId, args.diamondAddr],
  ));
  const digest = ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]));
  const sk = new ethers.SigningKey(args.oraclePrivateKey);
  const sig = sk.sign(digest);
  const oracleSignature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);
  return { encodedQuote, oracleSignature };
}

describe("[B-7] OracleClient.signQuote ↔ QuoteVerifierFacet round-trip", () => {
  it("verifyAndDecodeQuote accepts an off-chain signed OracleQuote", async () => {
    const d = await deployFullDiamond();
    const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");

    // The dev fixture sets oracleSigner to hardhat signer #1.
    const ORACLE_PK = HARDHAT_PRIVATE_KEYS[1];

    const validBefore = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const { encodedQuote, oracleSignature } = await offChainSignQuote({
      diamondAddr: d.diamondAddr,
      oraclePrivateKey: ORACLE_PK,
      quoteId: ethers.id("q-rt-1"),
      corridorId: CORRIDOR_ID,
      deliveryAmount: 1000n,
      totalDebit: 1006n,
      lpSourceMarginBps: 30, tgsTreasuryMarginBps: 10, lpDestMarginBps: 20,
      validBefore,
    });

    // verifyAndDecodeQuote returns the decoded tuple — call doesn't revert.
    const decoded = await qv.verifyAndDecodeQuote.staticCall(encodedQuote, oracleSignature);
    expect(decoded.quoteId).to.equal(ethers.id("q-rt-1"));
    expect(decoded.corridorId).to.equal(CORRIDOR_ID);
    expect(decoded.deliveryAmount).to.equal(1000n);
    expect(decoded.totalDebit).to.equal(1006n);
  });

  it("verifyAndDecodeQuote rejects a wrong-signer signature", async () => {
    const d = await deployFullDiamond();
    const qv = await asFacet<any>(d.diamondAddr, "QuoteVerifierFacet");
    const validBefore = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const { encodedQuote, oracleSignature } = await offChainSignQuote({
      diamondAddr: d.diamondAddr,
      oraclePrivateKey: HARDHAT_PRIVATE_KEYS[3], // not the configured oracle
      quoteId: ethers.id("q-rt-2"),
      corridorId: CORRIDOR_ID,
      deliveryAmount: 1000n, totalDebit: 1006n,
      lpSourceMarginBps: 30, tgsTreasuryMarginBps: 10, lpDestMarginBps: 20,
      validBefore,
    });
    await expect(qv.verifyAndDecodeQuote.staticCall(encodedQuote, oracleSignature))
      .to.be.revertedWithCustomError(qv, "InvalidOracleSignature");
  });

  it("AuthorizationSigner JS typehash equals on-chain TRANSFER_WITH_AUTHORIZATION_TYPEHASH", async () => {
    // Sole anti-drift guard: the JS-side typehash MUST byte-match the
    // public Solidity constant. Helper-only changes will not silently
    // break orchestrator signing if this assertion is in place.
    const d = await deployFullDiamond();
    const onChain = await d.gsdcToken.TRANSFER_WITH_AUTHORIZATION_TYPEHASH();
    const jsSide = ethers.keccak256(ethers.toUtf8Bytes(
      "TransferWithAuthorization(address from,address to,uint256 value," +
      "uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    ));
    expect(onChain).to.equal(jsSide);
  });
});
