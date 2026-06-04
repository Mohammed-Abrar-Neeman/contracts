// [Task 4] Off-chain signing helpers for the Sepolia validation script.
//
// Mirrors the production helpers in contracts/test/helpers.ts, but lives
// under scripts/ so production scripts don't depend on the test tree
// (avoids dragging mocha/chai into the deploy/validation runtime).
//
// The two primitives below are byte-identical to the test versions:
//   - buildSignedQuote()         — EIP-712 OracleQuote signature
//   - signEIP3009Authorization() — EIP-3009 TransferWithAuthorization sig
//
// Both produce signatures the deployed contracts accept verbatim.

import { ethers } from "hardhat";

export interface QuoteInputs {
  quoteId: string;
  corridorId: string;
  deliveryAmount: bigint;
  lpSourceBps: number;
  tgsTreasuryBps: number;
  lpDestBps: number;
  validBefore?: bigint;
  midRate?: string;
}

export interface SignedQuote {
  encodedQuote: string;
  oracleSignature: string;
  totalDebit: bigint;
  validBefore: bigint;
  midRate: string;
}

/** Builds an abi-encoded OracleQuote tuple + a 65-byte EIP-712 signature
 *  produced by the supplied oracle wallet, byte-identical to what
 *  QuoteVerifierFacet.verifyAndDecodeQuote expects. */
export async function buildSignedQuote(
  diamondAddr: string,
  oraclePrivateKey: string,
  inputs: QuoteInputs,
): Promise<SignedQuote> {
  const lpSourceMargin = (inputs.deliveryAmount * BigInt(inputs.lpSourceBps)) / 10_000n;
  const tgsTreasuryMargin = (inputs.deliveryAmount * BigInt(inputs.tgsTreasuryBps)) / 10_000n;
  const lpDestMargin = (inputs.deliveryAmount * BigInt(inputs.lpDestBps)) / 10_000n;
  const totalDebit = inputs.deliveryAmount + lpSourceMargin + tgsTreasuryMargin + lpDestMargin;
  const blockTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const validBefore = inputs.validBefore ?? (blockTs + 3600n);
  const midRate = inputs.midRate ?? "1.00000000";

  const tuple = [
    inputs.quoteId, inputs.corridorId, inputs.deliveryAmount, totalDebit,
    BigInt(inputs.lpSourceBps), BigInt(inputs.tgsTreasuryBps), BigInt(inputs.lpDestBps),
    0n, validBefore, midRate,
  ];
  const encodedQuote = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,string)"],
    [tuple],
  );

  const TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(
    "OracleQuote(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount," +
    "uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps," +
    "uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate)",
  ));
  const structHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32","bytes32","bytes32","uint256","uint256","uint256","uint256","uint256","uint256","uint256","bytes32"],
    [TYPEHASH, inputs.quoteId, inputs.corridorId, inputs.deliveryAmount, totalDebit,
      BigInt(inputs.lpSourceBps), BigInt(inputs.tgsTreasuryBps), BigInt(inputs.lpDestBps),
      0n, validBefore, ethers.keccak256(ethers.toUtf8Bytes(midRate))],
  ));
  const domainTypeHash = ethers.keccak256(ethers.toUtf8Bytes(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
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
  const sk = new ethers.SigningKey(oraclePrivateKey);
  const sig = sk.sign(digest);
  const oracleSignature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);

  return { encodedQuote, oracleSignature, totalDebit, validBefore, midRate };
}

/** Produces a 97-byte EIP-3009 authorization (validBefore || r || s || v)
 *  that SettlementExecutorFacet._redeemAuthorization decodes. */
export async function signEIP3009Authorization(args: {
  tokenAddr: string;
  fromPrivateKey: string;
  fromAddress: string;
  to: string;
  value: bigint;
  settlementId: string;
  validBefore?: bigint;
}): Promise<string> {
  const blockTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const validBefore = args.validBefore ?? (blockTs + 3600n);

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: "GSDC",
    version: "1",
    chainId: Number(chainId),
    verifyingContract: args.tokenAddr,
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from",         type: "address" },
      { name: "to",           type: "address" },
      { name: "value",        type: "uint256" },
      { name: "validAfter",   type: "uint256" },
      { name: "validBefore",  type: "uint256" },
      { name: "nonce",        type: "bytes32" },
    ],
  };
  const message = {
    from: args.fromAddress,
    to: args.to,
    value: args.value,
    validAfter: 0n,
    validBefore,
    nonce: args.settlementId,
  };
  const wallet = new ethers.Wallet(args.fromPrivateKey);
  const sigHex = await wallet.signTypedData(domain, types, message);
  const split = ethers.Signature.from(sigHex);
  return ethers.concat([
    ethers.zeroPadValue(ethers.toBeHex(validBefore), 32),
    split.r,
    split.s,
    ethers.toBeHex(split.v, 1),
  ]);
}

/** Produces a raw 65-byte EIP-3009 signature decomposed into v/r/s for
 *  callers that invoke GSDCToken.transferWithAuthorization directly
 *  (rather than via the SettlementExecutorFacet wrapper). */
export async function signEIP3009Raw(args: {
  tokenAddr: string;
  fromPrivateKey: string;
  fromAddress: string;
  to: string;
  value: bigint;
  nonce: string;
  validBefore?: bigint;
}): Promise<{ v: number; r: string; s: string; validBefore: bigint }> {
  const blockTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const validBefore = args.validBefore ?? (blockTs + 3600n);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: "GSDC", version: "1",
    chainId: Number(chainId), verifyingContract: args.tokenAddr,
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from",         type: "address" },
      { name: "to",           type: "address" },
      { name: "value",        type: "uint256" },
      { name: "validAfter",   type: "uint256" },
      { name: "validBefore",  type: "uint256" },
      { name: "nonce",        type: "bytes32" },
    ],
  };
  const message = {
    from: args.fromAddress,
    to: args.to,
    value: args.value,
    validAfter: 0n,
    validBefore,
    nonce: args.nonce,
  };
  const wallet = new ethers.Wallet(args.fromPrivateKey);
  const sigHex = await wallet.signTypedData(domain, types, message);
  const s = ethers.Signature.from(sigHex);
  return { v: s.v, r: s.r, s: s.s, validBefore };
}
