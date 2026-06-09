// Helpers shared across test files.
import { ethers } from "hardhat";
import { Contract, ZeroAddress } from "ethers";
import { getSelectors, FacetCutAction } from "../scripts/lib/diamond";

export const ZERO = ZeroAddress;

export interface DeployedDiamond {
  diamond: Contract;       // raw Diamond proxy at full ABI
  diamondAddr: string;
  gsdcToken: Contract;
  gsdcAddr: string;
  facets: Record<string, string>;
  tgsMarginWallet: Contract;
  tgsMarginAddr: string;
  admin: string;
  oracleSigner: any; // ethers Signer
}

// [Task 33] Snapshot-cached fixture.
//
// The original `deployFullDiamond` deploys ~16 contracts (GSDC token,
// Diamond, DiamondInit, MarginWallet, plus 12 facets) and performs a
// diamondCut + ownership transfer on every invocation. Across the test
// corpus this helper is called ~160 times, which under
// solidity-coverage's instrumented build pushes a full `hardhat
// coverage` run past the 15-minute budget (Task 31 had to kill it).
//
// The deployment itself is pure setup with no per-test variation, so
// we deploy it once per Hardhat process, take an EVM snapshot of the
// post-deploy state, and revert to that snapshot on every subsequent
// call. evm_revert consumes the snapshot, so we immediately retake it
// so the cache survives any number of consecutive calls. The returned
// object (contract instances + addresses) remains valid across reverts
// because ethers `Contract` bindings are pure address+ABI handles and
// the underlying storage is restored by the revert.
let _cachedDiamond: DeployedDiamond | null = null;
let _diamondSnapshotId: string | null = null;

/**
 * Drops the cached Diamond fixture. The next `deployFullDiamond()` call
 * will perform a full fresh deployment. Tests that mutate process-wide
 * state outside the EVM (rare) can call this to force a clean slate.
 */
export function resetDiamondFixture(): void {
  _cachedDiamond = null;
  _diamondSnapshotId = null;
}

export async function deployFullDiamond(): Promise<DeployedDiamond> {
  if (_cachedDiamond && _diamondSnapshotId) {
    const ok = await ethers.provider.send("evm_revert", [_diamondSnapshotId]);
    if (ok) {
      // evm_revert deletes the snapshot — retake it so the next call
      // can revert to the same clean post-deploy state.
      _diamondSnapshotId = await ethers.provider.send("evm_snapshot", []);
      return _cachedDiamond;
    }
    // Snapshot was invalidated (e.g. Hardhat node was reset). Fall
    // through to a full redeploy.
    _cachedDiamond = null;
    _diamondSnapshotId = null;
  }
  const fresh = await _deployFullDiamondImpl();
  _cachedDiamond = fresh;
  _diamondSnapshotId = await ethers.provider.send("evm_snapshot", []);
  return fresh;
}

async function _deployFullDiamondImpl(): Promise<DeployedDiamond> {
  const [deployer, oracle] = await ethers.getSigners();

  // GSDC token
  const Token = await ethers.getContractFactory("GSDCToken");
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();
  const gsdcAddr = await token.getAddress();

  // DiamondCutFacet + Diamond
  const DCF = await ethers.getContractFactory("DiamondCutFacet");
  const cut = await DCF.deploy();
  await cut.waitForDeployment();
  const cutAddr = await cut.getAddress();

  const Diamond = await ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(deployer.address, cutAddr);
  await diamond.waitForDeployment();
  const diamondAddr = await diamond.getAddress();

  const Init = await ethers.getContractFactory("DiamondInit");
  const init = await Init.deploy();
  await init.waitForDeployment();
  const initAddr = await init.getAddress();

  // TGS treasury margin wallet
  const MW = await ethers.getContractFactory("MarginWallet");
  const tgsMargin = await MW.deploy(gsdcAddr, deployer.address, diamondAddr);
  await tgsMargin.waitForDeployment();
  const tgsMarginAddr = await tgsMargin.getAddress();

  const facetNames = [
    "DiamondLoupeFacet",
    "QuoteVerifierFacet",
    "FloatManagerFacet",
    "SettlementExecutorFacet",
    "MarginSplitterFacet",
    "ComplianceGateFacet",
    "TimeLockControllerFacet",
    "DisputeResolverFacet",
    "EventEmitterFacet",
    "MintBurnAuthorityFacet",
    // [B-12 §3] Whitelist + threshold management facet.
    "OracleGovernanceFacet",
    // [Req 36.5] Wire PausableFacet into every deployFullDiamond call
    // so pause/unpause tests and pause-gate tests work out of the box.
    "PausableFacet",
  ];
  const cuts: { facetAddress: string; action: number; functionSelectors: string[] }[] = [];
  const facets: Record<string, string> = {};
  for (const name of facetNames) {
    const F = await ethers.getContractFactory(name);
    const f = await F.deploy();
    await f.waitForDeployment();
    const a = await f.getAddress();
    facets[name] = a;
    cuts.push({
      facetAddress: a,
      action: FacetCutAction.Add,
      functionSelectors: getSelectors(F.interface),
    });
  }

  const initData = init.interface.encodeFunctionData("init", [{
    admin: deployer.address,
    // [B-14 C3] Tests: orchestrator == admin to preserve fixture
    // behaviour. The dedicated role-separation test passes a distinct
    // EOA when it needs to assert independent gating.
    orchestrator: deployer.address,
    oracleSigner: oracle.address,
    gsdcToken: gsdcAddr,
    tgsTreasuryWallet: deployer.address,
    tgsTreasuryMarginWallet: tgsMarginAddr,
    maxQuoteTTL: 300,
    timeLockDelay: 60, // 60s for testing
  }]);
  const dCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
  await (await dCut.diamondCut(cuts, initAddr, initData)).wait();

  // Transfer GSDC ownership to the Diamond so MintBurnAuthorityFacet can mint/burn.
  await (await token.transferOwnership(diamondAddr)).wait();

  return {
    diamond: diamond as unknown as Contract,
    diamondAddr,
    gsdcToken: token as unknown as Contract,
    gsdcAddr,
    facets,
    tgsMarginWallet: tgsMargin as unknown as Contract,
    tgsMarginAddr,
    admin: deployer.address,
    oracleSigner: oracle,
  };
}

/** Returns the Diamond address typed as a given facet ABI (for delegatecall hits). */
export async function asFacet<T = Contract>(diamondAddr: string, facetName: string): Promise<T> {
  return (await ethers.getContractAt(facetName, diamondAddr)) as unknown as T;
}

// ─── B-6 [CARRY-CRITICAL] helpers — used by tests that need real
// EIP-712 signed oracle quotes + EIP-3009 transfer authorizations
// after the executeSettlement bypass was removed.
// ─────────────────────────────────────────────────────────────

/** Hardhat default-mnemonic private keys — needed because Hardhat's
 *  signers don't expose private-key material via the JsonRpcProvider,
 *  but we need raw keys for EIP-712 + EIP-3009 signing. The default
 *  mnemonic is fixed and well-known: "test test test test test test test
 *  test test test test junk". */
export const HARDHAT_PRIVATE_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // signer 0 (deployer/admin)
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // signer 1 (oracle)
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // signer 2
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // signer 3
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // signer 4
];

export interface QuoteInputs {
  quoteId: string;        // bytes32
  corridorId: string;     // bytes32
  deliveryAmount: bigint;
  lpSourceBps: number;
  tgsTreasuryBps: number;
  lpDestBps: number;
  validBefore?: bigint;
  // [Task 31] Allow tests to inject a non-zero validAfter so the aggregated
  // NotYetValid branch in QuoteVerifierFacet becomes reachable from
  // buildSignedAggregatedQuote (previously hardcoded to 0n).
  validAfter?: bigint;
  midRate?: string;
  // [B-14 C8] Path A: dynamic signing helpers absorb the new field.
  // Test corpus stays maintainable across future typehash changes.
  isOverridden?: boolean;
}

export interface SignedQuote {
  encodedQuote: string;
  oracleSignature: string;
  totalDebit: bigint;
}

/** Builds an abi-encoded OracleQuote tuple + a 65-byte EIP-712 signature
 *  produced by the supplied oracle wallet. The EIP-712 domain is the
 *  exact one QuoteVerifierFacet expects (name="GSDCOracle", version="1",
 *  chainId=current, verifyingContract=diamondAddr). */
export async function buildSignedQuote(
  diamondAddr: string,
  oracleWallet: { privateKey: string },
  inputs: QuoteInputs,
): Promise<SignedQuote> {
  const lpSourceMargin = (inputs.deliveryAmount * BigInt(inputs.lpSourceBps)) / 10_000n;
  const tgsTreasuryMargin = (inputs.deliveryAmount * BigInt(inputs.tgsTreasuryBps)) / 10_000n;
  const lpDestMargin = (inputs.deliveryAmount * BigInt(inputs.lpDestBps)) / 10_000n;
  const totalDebit = inputs.deliveryAmount + lpSourceMargin + tgsTreasuryMargin + lpDestMargin;
  // [B-7] Use the chain's latest block.timestamp (not Date.now()) — earlier tests in the
  // same suite call evm_increaseTime, which advances the Hardhat clock past wall-clock now.
  const blockTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  // [Req 38.4/38.5] Default to blockTs + 299 so quotes stay within the
  // maxQuoteTTL = 300 cap enforced by QuoteVerifierFacet. Callers that
  // need a longer or custom window can pass an explicit validBefore.
  const validBefore = inputs.validBefore ?? (blockTs + 299n);
  const validAfter = inputs.validAfter ?? 0n;
  const midRate = inputs.midRate ?? "1.00000000";

  const quote = {
    quoteId: inputs.quoteId,
    corridorId: inputs.corridorId,
    deliveryAmount: inputs.deliveryAmount,
    totalDebit,
    lpSourceMarginBps: BigInt(inputs.lpSourceBps),
    tgsTreasuryMarginBps: BigInt(inputs.tgsTreasuryBps),
    lpDestMarginBps: BigInt(inputs.lpDestBps),
    validAfter,
    validBefore,
    midRate,
    // [B-14 C8] isOverridden bound to signature at sign-time.
    isOverridden: inputs.isOverridden ?? false,
  };
  const encodedQuote = ethers.AbiCoder.defaultAbiCoder().encode(
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
      diamondAddr],
  ));
  const digest = ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]));
  const sk = new ethers.SigningKey(oracleWallet.privateKey);
  const sig = sk.sign(digest);
  const oracleSignature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);

  return { encodedQuote, oracleSignature, totalDebit };
}

/** Produces a 65-byte EIP-3009 transferWithAuthorization signature for
 *  GSDCToken. nonce = settlementId (binds the auth to one settlement,
 *  preventing cross-settlement replay). */
export async function signEIP3009Authorization(args: {
  tokenAddr: string;
  from: { privateKey: string; address: string };
  to: string;
  value: bigint;
  settlementId: string;     // bytes32, used as the EIP-3009 nonce
  validBefore?: bigint;
}): Promise<string> {
  // [B-7] Use the chain's latest block.timestamp (not Date.now()) — earlier tests in the
  // same hardhat process call evm_increaseTime, which advances the EVM clock past wall-clock now.
  // Wall-clock validBefore would then satisfy `< block.timestamp` and AuthorizationExpired.
  const blockTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const validBefore = args.validBefore ?? (blockTs + 3600n);
  const validAfter = 0n;

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const tokenName = "GSDC"; // GSDCToken EIP712 domain name (see GSDCToken.sol)
  const tokenVersion = "1";

  const domain = {
    name: tokenName,
    version: tokenVersion,
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
    from: args.from.address,
    to: args.to,
    value: args.value,
    validAfter,
    validBefore,
    nonce: args.settlementId,
  };
  const wallet = new ethers.Wallet(args.from.privateKey);
  const sigHex = await wallet.signTypedData(domain, types, message);
  // Convert ethers compact 65-byte serialized signature to r||s||v.
  const split = ethers.Signature.from(sigHex);
  // [B-6 CARRY-CRITICAL] Prepend a 32-byte validBefore so the contract's
  // _redeemAuthorization can reconstruct the exact digest the user
  // signed. Total layout: validBefore(32) || r(32) || s(32) || v(1) = 97.
  return ethers.concat([
    ethers.zeroPadValue(ethers.toBeHex(validBefore), 32),
    split.r,
    split.s,
    ethers.toBeHex(split.v, 1),
  ]);
}

// ─── [B-12 §9] Multi-signer EIP-712 helper ──────────────────────────
// Builds an abi-encoded OracleQuote tuple plus N signatures over the
// OracleQuoteAggregated typehash digest. Each entry in `signerKeys`
// signs the same digest. Use `bogusSignerKey` to inject a non-
// whitelisted signer for negative tests.

export interface AggregatedQuoteInputs extends QuoteInputs {
  reportsRoot?: string;
  // [B-14 C8] isOverridden is inherited from QuoteInputs.
}

export interface SignedAggregatedQuote {
  encodedQuote: string;
  signatures: string[];
  reportsRoot: string;
  totalDebit: bigint;
}

export async function buildSignedAggregatedQuote(
  diamondAddr: string,
  signerKeys: string[],
  inputs: AggregatedQuoteInputs,
): Promise<SignedAggregatedQuote> {
  const lpSourceMargin = (inputs.deliveryAmount * BigInt(inputs.lpSourceBps)) / 10_000n;
  const tgsTreasuryMargin = (inputs.deliveryAmount * BigInt(inputs.tgsTreasuryBps)) / 10_000n;
  const lpDestMargin = (inputs.deliveryAmount * BigInt(inputs.lpDestBps)) / 10_000n;
  const totalDebit = inputs.deliveryAmount + lpSourceMargin + tgsTreasuryMargin + lpDestMargin;
  const blockTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const validBefore = inputs.validBefore ?? (blockTs + 3600n);
  // [Task 31] Honour caller-supplied validAfter (was hardcoded to 0n)
  // so the aggregated NotYetValid branch is reachable from tests.
  const validAfter = inputs.validAfter ?? 0n;
  const midRate = inputs.midRate ?? "1.00000000";
  const reportsRoot = inputs.reportsRoot ?? ethers.ZeroHash;

  const tuple = [
    inputs.quoteId, inputs.corridorId, inputs.deliveryAmount, totalDebit,
    BigInt(inputs.lpSourceBps), BigInt(inputs.tgsTreasuryBps), BigInt(inputs.lpDestBps),
    validAfter, validBefore, midRate,
    // [B-14 C8] isOverridden as last tuple element to mirror struct order.
    inputs.isOverridden ?? false,
  ];
  const encodedQuote = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,string,bool)"],
    [tuple],
  );

  const TYPEHASH_AGG = ethers.keccak256(ethers.toUtf8Bytes(
    "OracleQuoteAggregated(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount," +
    "uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps," +
    "uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate," +
    "bytes32 reportsRoot,bool isOverridden)"
  ));
  const structHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32","bytes32","bytes32","uint256","uint256","uint256","uint256","uint256","uint256","uint256","bytes32","bytes32","bool"],
    [TYPEHASH_AGG, inputs.quoteId, inputs.corridorId, inputs.deliveryAmount, totalDebit,
      BigInt(inputs.lpSourceBps), BigInt(inputs.tgsTreasuryBps), BigInt(inputs.lpDestBps),
      validAfter, validBefore, ethers.keccak256(ethers.toUtf8Bytes(midRate)), reportsRoot,
      inputs.isOverridden ?? false],
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
  const signatures = signerKeys.map((pk) => {
    const sk = new ethers.SigningKey(pk);
    const sig = sk.sign(digest);
    return ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);
  });
  return { encodedQuote, signatures, reportsRoot, totalDebit };
}

// [B-16 β] Test helper — queue+execute via the unified time-lock dispatcher.
//
// Pattern: call the queue function on the originating facet, capture
// the ChangeQueued event's changeId, fast-forward EVM time past
// timeLockDelay, then call executeChange on TimeLockControllerFacet.
//
// Default delay is whatever the diamond was initialised with (currently
// 0 in test bootstraps so the time-warp is symbolic but harmless). If
// a test wants to verify the readiness gate, pass `delaySeconds` to
// have the helper read it back from the diamond and warp past it.
export async function queueAndExecute(
  diamondAddr: string,
  facetName: string,
  fnName: string,
  args: unknown[],
  opts: { caller?: any } = {},
): Promise<string> {
  const facetForQueue = opts.caller
    ? await ethers.getContractAt(facetName, diamondAddr, opts.caller)
    : await ethers.getContractAt(facetName, diamondAddr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = await (facetForQueue as any)[fnName](...args);
  const receipt = await tx.wait();
  // ChangeQueued(changeId indexed, executeAfter)
  // changeId is the first topic after the event signature topic.
  const ev = receipt.logs.find((l: { topics: string[]; data: string }) => {
    try {
      const parsed = (facetForQueue as { interface: { parseLog: (l: unknown) => { name: string } | null } }).interface.parseLog(l);
      return parsed?.name === "ChangeQueued";
    } catch { return false; }
  });
  if (!ev) throw new Error(`queueAndExecute: ChangeQueued not emitted by ${facetName}.${fnName}`);
  const changeId = ev.topics[1] as string;

  // Time-warp past the readiness gate. Read latest block timestamp
  // (NOT Date.now() — EVM time drifts under repeated test runs after
  // evm_increaseTime calls).
  const tl = await ethers.getContractAt("TimeLockControllerFacet", diamondAddr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readyAt = await (tl as any).getPendingChange(changeId);
  if (readyAt > 0n) {
    const block = await ethers.provider.getBlock("latest");
    const now = BigInt(block!.timestamp);
    const delta = readyAt > now ? Number(readyAt - now) + 1 : 1;
    await ethers.provider.send("evm_increaseTime", [delta]);
    await ethers.provider.send("evm_mine", []);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (tl as any).executeChange(changeId);
  return changeId;
}

