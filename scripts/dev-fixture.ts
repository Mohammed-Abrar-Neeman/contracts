// Tier B-5 — local Hardhat dev fixture.
//
// One-shot script: deploys the full GSDC stack on the local Hardhat
// network, configures the 4 active pilot corridors, registers two demo
// partners with margin wallets, and funds two demo EOAs with GSDC.
//
// Run via:   yarn hardhat run scripts/dev-fixture.ts --network hardhat
//
// [SPEC §B-5] dev-fixture provides the seed state every backend
// integration test (B-6 onward) leans on. Keep idempotent — running on
// a fresh in-memory hardhat node should always produce the same
// addresses for the same nonce sequence.
//
// [GAP] amount + account defaults:
//   - DEMO_FLOAT_AMOUNT = 10_000_000 GSDC (10M × 1e18) — large enough to
//     cover all positive-path settlement tests for B-6/B-7 without
//     re-funding between cases.
//   - DEMO_PARTNER_1 = hardhat signer #1 (Bharat / source IN)
//   - DEMO_PARTNER_2 = hardhat signer #2 (Zenith / dest HK)
//   These choices match the four active corridors:
//     INR_CNH (P1→P2), CNH_INR (P2→P1), BRL_CNH (P1→P2 stand-in for SP),
//     CNH_BRL (P2→P1 stand-in).

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getSelectors, FacetCutAction } from "./lib/diamond";

const DEMO_FLOAT_AMOUNT = ethers.parseUnits("10000000", 18); // 10M GSDC

// [B-12 §8] DON signer count + threshold. 5-of-3 is the production
// pilot baseline. Keys are deterministic so re-runs of dev-fixture
// produce the same whitelist — useful for integration test stability.
const DON_SIGNER_COUNT = 5;
const DON_THRESHOLD = 3;

const ACTIVE_CORRIDORS = [
  { id: "INR_CNH", minAmount: 1000n, maxAmount: 0n,   srcBps: 20, treBps: 20, dstBps: 10 },
  { id: "BRL_CNH", minAmount: 1000n, maxAmount: 0n,   srcBps: 20, treBps: 20, dstBps: 10 },
  { id: "CNH_INR", minAmount: 1000n, maxAmount: 0n,   srcBps: 20, treBps: 20, dstBps: 10 },
  { id: "CNH_BRL", minAmount: 1000n, maxAmount: 0n,   srcBps: 20, treBps: 20, dstBps: 10 },
];

function corridorBytes32(id: string): string {
  return ethers.encodeBytes32String(id);
}

async function main() {
  console.log(`[dev-fixture] network=${network.name}`);
  if (network.name === "sepolia") {
    throw new Error("[dev-fixture] refusing to run on Sepolia — local fixture only");
  }

  const signers = await ethers.getSigners();
  const [deployer, partner1, partner2] = signers;
  console.log(`[dev-fixture] deployer=${deployer.address}`);
  console.log(`[dev-fixture] partner1=${partner1.address}`);
  console.log(`[dev-fixture] partner2=${partner2.address}`);

  // 1. GSDC token.
  const Token = await ethers.getContractFactory("GSDCToken");
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();
  const gsdcToken = await token.getAddress();
  console.log(`[dev-fixture] GSDCToken → ${gsdcToken}`);

  // 2. DiamondCutFacet then Diamond.
  const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
  const cutFacet = await DiamondCutFacet.deploy();
  await cutFacet.waitForDeployment();

  const Diamond = await ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(deployer.address, await cutFacet.getAddress());
  await diamond.waitForDeployment();
  const diamondAddr = await diamond.getAddress();
  console.log(`[dev-fixture] Diamond → ${diamondAddr}`);

  // 3. DiamondInit.
  const DiamondInit = await ethers.getContractFactory("DiamondInit");
  const init = await DiamondInit.deploy();
  await init.waitForDeployment();

  // 4. TGS treasury margin wallet.
  const MarginWallet = await ethers.getContractFactory("MarginWallet");
  const tgsMargin = await MarginWallet.deploy(gsdcToken, deployer.address, diamondAddr);
  await tgsMargin.waitForDeployment();
  const tgsMarginAddr = await tgsMargin.getAddress();

  // 5. Deploy + cut all 10 remaining facets.
  const facetNames = [
    "DiamondLoupeFacet", "QuoteVerifierFacet", "FloatManagerFacet",
    "SettlementExecutorFacet", "MarginSplitterFacet", "ComplianceGateFacet",
    "TimeLockControllerFacet", "DisputeResolverFacet",
    "EventEmitterFacet", "MintBurnAuthorityFacet",
    // [B-12 §3] OracleGovernanceFacet — DON whitelist + threshold mgmt.
    "OracleGovernanceFacet",
  ];
  const cuts: { facetAddress: string; action: number; functionSelectors: string[] }[] = [];
  const facetAddresses: Record<string, string> = {};
  for (const name of facetNames) {
    const F = await ethers.getContractFactory(name);
    const f = await F.deploy();
    await f.waitForDeployment();
    const a = await f.getAddress();
    facetAddresses[name] = a;
    cuts.push({
      facetAddress: a,
      action: FacetCutAction.Add,
      functionSelectors: getSelectors(F.interface),
    });
  }

  const initIface = init.interface;
  const initCalldata = initIface.encodeFunctionData("init", [{
    admin: deployer.address,
    // [B-14 C3] dev-fixture: orchestrator == admin (single hardhat EOA
    // signs everything). DiamondInit's zero-fallback ALSO preserves
    // this for any legacy 7-arg caller; passing the field explicitly
    // here keeps the dev-fixture's surface honest.
    orchestrator: deployer.address,
    oracleSigner: deployer.address,        // dev: deployer signs oracle quotes too
    gsdcToken,
    tgsTreasuryWallet: deployer.address,
    tgsTreasuryMarginWallet: tgsMarginAddr,
    maxQuoteTTL: 300,
    timeLockDelay: 0,                       // dev: no delay so margin updates execute instantly
  }]);
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
  await (await diamondCut.diamondCut(cuts, await init.getAddress(), initCalldata)).wait();
  console.log(`[dev-fixture] diamond cut + init complete (${facetNames.length + 1} facets)`);

  // 6. Per-partner MarginWallets.
  const p1Margin = await MarginWallet.deploy(gsdcToken, partner1.address, diamondAddr);
  await p1Margin.waitForDeployment();
  const p2Margin = await MarginWallet.deploy(gsdcToken, partner2.address, diamondAddr);
  await p2Margin.waitForDeployment();

  // 7. Register the two partners with all 4 corridors authorised.
  const compliance = await ethers.getContractAt("ComplianceGateFacet", diamondAddr);
  const corridorIdsBytes = ACTIVE_CORRIDORS.map((c) => corridorBytes32(c.id));
  await (await compliance.registerPartner(
    partner1.address, partner1.address, await p1Margin.getAddress(),
    ethers.id("partner1-kyc"), corridorIdsBytes,
  )).wait();
  await (await compliance.registerPartner(
    partner2.address, partner2.address, await p2Margin.getAddress(),
    ethers.id("partner2-kyc"), corridorIdsBytes,
  )).wait();
  console.log(`[dev-fixture] registered 2 partners with ${corridorIdsBytes.length} corridors each`);

  // 8. Configure each corridor: active=true, min/max bounds, full window.
  const timeLock = await ethers.getContractAt("TimeLockControllerFacet", diamondAddr);
  for (const c of ACTIVE_CORRIDORS) {
    const cb = corridorBytes32(c.id);
    await (await timeLock.configureCorridor(cb, true, c.minAmount, c.maxAmount, 0, 86399)).wait();
    // Margin bps via queueMarginUpdate (timeLockDelay=0 means executeChange is immediately ready).
    const queueTx = await timeLock.queueMarginUpdate(cb, c.srcBps, c.treBps, c.dstBps);
    const queueReceipt = await queueTx.wait();
    const queuedEvent = queueReceipt!.logs
      .map((l) => { try { return timeLock.interface.parseLog({ topics: Array.from(l.topics), data: l.data }); } catch { return null; } })
      .find((p) => p?.name === "ChangeQueued");
    if (!queuedEvent) throw new Error(`[dev-fixture] ChangeQueued event missing for ${c.id}`);
    const changeId = queuedEvent.args[0] as string;
    await (await timeLock.executeChange(changeId)).wait();
  }
  console.log(`[dev-fixture] configured ${ACTIVE_CORRIDORS.length} active corridors`);

  // 9. Fund both demo EOAs.
  const tokenAsDeployer = token.connect(deployer) as typeof token;
  await (await tokenAsDeployer.mint(partner1.address, DEMO_FLOAT_AMOUNT)).wait();
  await (await tokenAsDeployer.mint(partner2.address, DEMO_FLOAT_AMOUNT)).wait();
  console.log(`[dev-fixture] minted ${DEMO_FLOAT_AMOUNT.toString()} GSDC to partner1 + partner2`);

  // 9.5. [B-6 CARRY] Fund each partner's MarginWallet with 1M GSDC so
  //      B-6 integration tests pass FloatManager.checkFloat() without
  //      manual top-up. Uses bare ERC-20 transfer (local-only fixture
  //      semantics — production deposits go through MarginWallet's
  //      onlyOwner deposit path).
  const PER_MARGIN = ethers.parseUnits("1000000", 18);
  const p1MarginAddr = await p1Margin.getAddress();
  const p2MarginAddr = await p2Margin.getAddress();
  await (await token.connect(partner1).transfer(p1MarginAddr, PER_MARGIN)).wait();
  await (await token.connect(partner2).transfer(p2MarginAddr, PER_MARGIN)).wait();
  console.log(`[dev-fixture] deposited ${PER_MARGIN.toString()} GSDC into each partner MarginWallet`);

  // 9.6. [B-12 §8] Seed DON signers. Generates DON_SIGNER_COUNT
  //      deterministic Hardhat wallets, calls setOracleSigners on the
  //      OracleGovernanceFacet, and writes private keys to .env.dev-don
  //      so backend MockDONAggregator picks them up.
  const donWallets: ethers.Wallet[] = [];
  for (let i = 0; i < DON_SIGNER_COUNT; i++) {
    // Deterministic mnemonic-free path: hash a fixed seed + index.
    const seed = ethers.keccak256(ethers.toUtf8Bytes(`gsdc-dev-don-signer-${i}`));
    donWallets.push(new ethers.Wallet(seed));
  }
  const donAddresses = donWallets.map((w) => w.address);
  // [B-16 β-2] setOracleSigners removed; route through the unified
  // queue/execute time-lock dispatcher.
  const oracleGov = await ethers.getContractAt("OracleGovernanceFacet", diamondAddr);
  const tl = await ethers.getContractAt("TimeLockControllerFacet", diamondAddr);
  const qTx = await oracleGov.queueOracleSignersChange(donAddresses, DON_THRESHOLD);
  const qRc = await qTx.wait();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = qRc!.logs.find((l: any) => {
    try { return oracleGov.interface.parseLog(l)?.name === "ChangeQueued"; } catch { return false; }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const changeId = (ev as any).topics[1] as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readyAt = await (tl as any).getPendingChange(changeId);
  if (readyAt > 0n) {
    const blk = await ethers.provider.getBlock("latest");
    const delta = Number(readyAt - BigInt(blk!.timestamp)) + 1;
    if (delta > 0) {
      await ethers.provider.send("evm_increaseTime", [delta]);
      await ethers.provider.send("evm_mine", []);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (await (tl as any).executeChange(changeId)).wait();
  console.log(`[dev-fixture] DON whitelist seeded: ${DON_SIGNER_COUNT} signers, threshold=${DON_THRESHOLD}`);

  // Write .env.dev-don for the backend to read. NOT committed —
  // .gitignore covers .env.dev-don alongside other .env* files. Loaded
  // explicitly by integration tests via `dotenv.config({path: ...})`.
  const envOut = [
    `# Auto-generated by contracts/scripts/dev-fixture.ts — DO NOT COMMIT.`,
    `ORACLE_MODE=MULTI_SIGNER`,
    `DON_MODE=mock`,
    ...donWallets.map((w, i) => `DON_SIGNER_${i + 1}_PRIVATE_KEY=${w.privateKey}`),
    ``,
  ].join("\n");
  const envFile = path.resolve(__dirname, "..", "..", "backend", ".env.dev-don");
  fs.writeFileSync(envFile, envOut);
  console.log(`[dev-fixture] DON env → ${envFile}`);

  // 10. Persist deployment manifest.
  const manifest = {
    network: network.name,
    diamond: diamondAddr,
    diamondCutFacet: await cutFacet.getAddress(),
    diamondInit: await init.getAddress(),
    tgsTreasuryMarginWallet: tgsMarginAddr,
    facets: facetAddresses,
    admin: deployer.address,
    oracleSigner: deployer.address,
    gsdcToken,
    partnerMarginWallets: {
      [partner1.address]: await p1Margin.getAddress(),
      [partner2.address]: await p2Margin.getAddress(),
    },
    activeCorridors: ACTIVE_CORRIDORS.map((c) => c.id),
    demoSigners: { partner1: partner1.address, partner2: partner2.address },
    // [B-12 §8] DON committee on-chain whitelist.
    donSigners: donAddresses,
    donThreshold: DON_THRESHOLD,
  };
  const dir = path.resolve(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  console.log(`[dev-fixture] manifest written → ${file}`);
  console.log(`[dev-fixture] DONE`);
}

main().catch((e) => { console.error(e); process.exit(1); });
