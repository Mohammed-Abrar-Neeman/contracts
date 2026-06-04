// [Task 4] Shared deployment helper used by both deploy-sepolia.ts and
// validate-sepolia.ts (the latter falls back to deploying when running
// the dry-run on the in-memory hardhat network and no manifest exists).
//
// Returns full address set + a JSON-serialisable manifest. Side-effects
// (writing files / verifying on Etherscan) live in the entry scripts.

import { ethers } from "hardhat";
import { getSelectors, FacetCutAction } from "./diamond";

export interface DeployedStack {
  deployer: string;
  admin: string;
  oracleSigner: string;
  gsdcToken: string;
  diamond: string;
  diamondCutFacet: string;
  diamondInit: string;
  tgsTreasuryMarginWallet: string;
  facets: Record<string, string>;
  chainId: number;
  timeLockDelay: number;
  maxQuoteTTL: number;
}

export const FACET_NAMES = [
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
  "OracleGovernanceFacet",
] as const;

/**
 * Deploy the full GSDC contract stack. Writes nothing — caller persists
 * the manifest. The deployer signer is used for admin + orchestrator;
 * `oracleSignerOverride` lets callers point the oracle elsewhere (else
 * deployer signs quotes too).
 *
 * `timeLockDelay = 0` for testnet so configureCorridor + queueMarginUpdate
 * round-trips don't have to wait 48h. Mainnet promotion overrides this.
 */
export async function deployStack(opts: {
  oracleSignerOverride?: string;
  timeLockDelay?: number;
  log?: (msg: string) => void;
} = {}): Promise<DeployedStack> {
  const log = opts.log ?? ((m) => console.log(m));
  const [deployer] = await ethers.getSigners();
  const oracleSigner = opts.oracleSignerOverride ?? deployer.address;
  const timeLockDelay = opts.timeLockDelay ?? 0;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  log(`[deploy-stack] deployer=${deployer.address} chainId=${chainId}`);

  const Token = await ethers.getContractFactory("GSDCToken");
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();
  const gsdcToken = await token.getAddress();
  log(`[deploy-stack] GSDCToken @ ${gsdcToken}`);

  const DCF = await ethers.getContractFactory("DiamondCutFacet");
  const cutFacet = await DCF.deploy();
  await cutFacet.waitForDeployment();
  const diamondCutFacet = await cutFacet.getAddress();

  const Diamond = await ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(deployer.address, diamondCutFacet);
  await diamond.waitForDeployment();
  const diamondAddr = await diamond.getAddress();
  log(`[deploy-stack] Diamond @ ${diamondAddr}`);

  const Init = await ethers.getContractFactory("DiamondInit");
  const init = await Init.deploy();
  await init.waitForDeployment();
  const diamondInit = await init.getAddress();

  const MW = await ethers.getContractFactory("MarginWallet");
  const tgsMargin = await MW.deploy(gsdcToken, deployer.address, diamondAddr);
  await tgsMargin.waitForDeployment();
  const tgsTreasuryMarginWallet = await tgsMargin.getAddress();

  const cuts: { facetAddress: string; action: number; functionSelectors: string[] }[] = [];
  const facets: Record<string, string> = {};
  for (const name of FACET_NAMES) {
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
    log(`[deploy-stack] ${name} @ ${a}`);
  }

  const initData = init.interface.encodeFunctionData("init", [{
    admin: deployer.address,
    orchestrator: deployer.address,
    oracleSigner,
    gsdcToken,
    tgsTreasuryWallet: deployer.address,
    tgsTreasuryMarginWallet,
    maxQuoteTTL: 300,
    timeLockDelay,
  }]);
  const dCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
  const cutTx = await dCut.diamondCut(cuts, diamondInit, initData);
  await cutTx.wait();
  log(`[deploy-stack] diamondCut + init complete (${FACET_NAMES.length} facets)`);

  // GSDC mint authority must be the Diamond so MintBurnAuthorityFacet
  // can call token.mint() / burn().
  await (await token.transferOwnership(diamondAddr)).wait();
  log(`[deploy-stack] GSDC mint authority transferred → Diamond`);

  return {
    deployer: deployer.address,
    admin: deployer.address,
    oracleSigner,
    gsdcToken,
    diamond: diamondAddr,
    diamondCutFacet,
    diamondInit,
    tgsTreasuryMarginWallet,
    facets,
    chainId,
    timeLockDelay,
    maxQuoteTTL: 300,
  };
}
