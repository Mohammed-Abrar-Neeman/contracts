// Deploys the Settlement Diamond + all 11 facets (2 infra + 9 domain) +
// runs the initial diamondCut so every facet's selectors are wired and
// DiamondInit sets admin/oracle/treasury/etc.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getSelectors, FacetCutAction } from "./lib/diamond";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`[deploy-diamond] network=${network.name} deployer=${deployer.address}`);

  const deploymentFile = path.resolve(__dirname, "..", "deployments", `${network.name}.json`);
  const deployments = fs.existsSync(deploymentFile)
    ? JSON.parse(fs.readFileSync(deploymentFile, "utf8"))
    : {};
  const gsdcToken = deployments.gsdcToken || process.env.GSDC_TOKEN_ADDRESS;
  if (!gsdcToken) {
    throw new Error("[deploy-diamond] gsdcToken not found — run deploy-token.ts first");
  }
  const oracleSigner = process.env.ORACLE_SIGNER_ADDRESS || deployer.address;
  const tgsTreasury = process.env.TGS_TREASURY_WALLET || deployer.address;

  // 1. Deploy DiamondCutFacet first — required by Diamond constructor.
  const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
  const cutFacet = await DiamondCutFacet.deploy();
  await cutFacet.waitForDeployment();
  const cutAddr = await cutFacet.getAddress();
  console.log(`[deploy-diamond] DiamondCutFacet → ${cutAddr}`);

  // 2. Deploy Diamond.
  const Diamond = await ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(deployer.address, cutAddr);
  await diamond.waitForDeployment();
  const diamondAddr = await diamond.getAddress();
  console.log(`[deploy-diamond] Diamond → ${diamondAddr}`);

  // 3. Deploy DiamondInit.
  const DiamondInit = await ethers.getContractFactory("DiamondInit");
  const init = await DiamondInit.deploy();
  await init.waitForDeployment();
  const initAddr = await init.getAddress();

  // 4. Deploy a treasury margin wallet placeholder (Diamond consumes it during init).
  const MarginWallet = await ethers.getContractFactory("MarginWallet");
  const tgsMarginWallet = await MarginWallet.deploy(gsdcToken, tgsTreasury, diamondAddr);
  await tgsMarginWallet.waitForDeployment();
  const tgsMarginAddr = await tgsMarginWallet.getAddress();
  console.log(`[deploy-diamond] TGS MarginWallet → ${tgsMarginAddr}`);

  // 5. Deploy each remaining facet + collect selectors for the cut.
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
    console.log(`[deploy-diamond] ${name} → ${a}`);
  }

  // 6. Run the cut + DiamondInit.
  const initIface = init.interface;
  const initCalldata = initIface.encodeFunctionData("init", [{
    admin: deployer.address,
    oracleSigner,
    gsdcToken,
    tgsTreasuryWallet: tgsTreasury,
    tgsTreasuryMarginWallet: tgsMarginAddr,
    maxQuoteTTL: 300,         // 5 minutes
    timeLockDelay: 48 * 60 * 60, // 48 hours per spec §2.7
  }]);
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
  const tx = await diamondCut.diamondCut(cuts, initAddr, initCalldata);
  await tx.wait();
  console.log(`[deploy-diamond] diamondCut + init done`);

  // 7. Persist deployment manifest.
  const manifest = {
    network: network.name,
    diamond: diamondAddr,
    diamondCutFacet: cutAddr,
    diamondInit: initAddr,
    tgsTreasuryMarginWallet: tgsMarginAddr,
    facets: facetAddresses,
    admin: deployer.address,
    oracleSigner,
    gsdcToken,
  };
  const dir = path.resolve(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  fs.writeFileSync(file, JSON.stringify({ ...prev, ...manifest }, null, 2));
  console.log(`[deploy-diamond] manifest written → ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
