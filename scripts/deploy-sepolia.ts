// [Task 4] Idempotent Sepolia deployment.
//
// What this script does:
//   1. Validates env: SEPOLIA_RPC_URL + DEPLOYER_PRIVATE_KEY (fail fast).
//   2. Reads contracts/deployments/<network>/manifest.json if present.
//      If diamond + facets are already populated, exits successfully
//      without re-broadcasting (idempotent).
//   3. Otherwise deploys: GSDCToken, Diamond, all 11 facets,
//      DiamondCutFacet, DiamondInit, TGS treasury MarginWallet, runs the
//      initial diamondCut, transfers GSDC mint authority to the Diamond.
//   4. Writes:
//        - contracts/deployments/<network>/manifest.json   (addresses)
//        - contracts/deployments/<network>/abis/<Name>.json (one per
//          deployed contract — sufficient to reconstruct ethers Contracts
//          off-chain without running `hardhat compile`).
//   5. Etherscan source-verification: when ETHERSCAN_API_KEY is set
//      and we're on a public network (i.e. not hardhat/localhost),
//      this script automatically invokes
//      scripts/verify-on-etherscan.ts in-process after writing the
//      manifest. Per-contract status (verified / already-verified /
//      failed / skipped) is stamped back into the manifest under
//      `verification`. Verification failures are logged but do NOT
//      fail the deploy step — operators can re-run `npm run verify`
//      to retry just the verification half. Set
//      SKIP_ETHERSCAN_VERIFY=1 to opt out of the in-flow verification.
//
// Run via:
//   pnpm --filter gsdc-contracts run deploy:sepolia
//   yarn hardhat run scripts/deploy-sepolia.ts --network sepolia
//   npx hardhat run scripts/deploy-sepolia.ts --network <other>
//
// Required env (sepolia only — hardhat reads nothing):
//   SEPOLIA_RPC_URL       — Infura/Alchemy endpoint
//   DEPLOYER_PRIVATE_KEY  — funded ≥ 0.3 ETH on Sepolia
//
// Optional env:
//   ORACLE_SIGNER_ADDRESS — alternate oracle signer; defaults to deployer
//   TIMELOCK_DELAY_SEC    — corridor margin time-lock; defaults to 0
//                           (testnet — production override is 48*3600)

import { artifacts, ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { deployStack, FACET_NAMES, DeployedStack } from "./lib/deploy-stack";
import { verifyDeploymentManifest, VerificationEntry } from "./verify-on-etherscan";

const SEPOLIA_CHAIN_ID = 11155111;

function manifestDir(): string {
  return path.resolve(__dirname, "..", "deployments", network.name);
}

function manifestPath(): string {
  return path.join(manifestDir(), "manifest.json");
}

function abisDir(): string {
  return path.join(manifestDir(), "abis");
}

interface PersistedManifest extends DeployedStack {
  network?: string;
  deployedAt?: string | null;
  updatedAt?: string | null;
  verification?: Record<string, VerificationEntry>;
  partnerMarginWallets?: Record<string, string>;
}

function readExistingManifest(): PersistedManifest | null {
  const p = manifestPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<PersistedManifest>;
    if (!raw.diamond || !raw.gsdcToken || !raw.facets) return null;
    if (FACET_NAMES.some((n) => !raw.facets![n])) return null;
    return raw as PersistedManifest;
  } catch {
    return null;
  }
}

function validateEnv(): void {
  if (network.name !== "sepolia") return; // hardhat / localhost dry-runs need no env.
  const missing: string[] = [];
  if (!process.env.SEPOLIA_RPC_URL) missing.push("SEPOLIA_RPC_URL");
  if (!process.env.DEPLOYER_PRIVATE_KEY) missing.push("DEPLOYER_PRIVATE_KEY");
  if (missing.length > 0) {
    throw new Error(
      `[deploy-sepolia] missing required env vars: ${missing.join(", ")}. ` +
      "See docs/testnet.md for setup.",
    );
  }
}

async function writeAbis(stack: DeployedStack): Promise<void> {
  const dir = abisDir();
  fs.mkdirSync(dir, { recursive: true });
  const targets = ["GSDCToken", "Diamond", "DiamondCutFacet", "DiamondInit",
    "MarginWallet", "ISettlementDiamond", "IEIP3009", ...FACET_NAMES];
  for (const name of targets) {
    try {
      const artifact = await artifacts.readArtifact(name);
      fs.writeFileSync(
        path.join(dir, `${name}.json`),
        JSON.stringify({ contractName: name, abi: artifact.abi }, null, 2) + "\n",
      );
    } catch (e) {
      console.warn(`[deploy-sepolia] could not read artifact for ${name}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  console.log(`[deploy-sepolia] wrote ABIs → ${dir}`);
}

async function main(): Promise<void> {
  validateEnv();
  console.log(`[deploy-sepolia] network=${network.name}`);

  if (network.name === "sepolia") {
    const [signer] = await ethers.getSigners();
    const bal = await ethers.provider.getBalance(signer.address);
    console.log(`[deploy-sepolia] deployer=${signer.address} balance=${ethers.formatEther(bal)} ETH`);
    // Sepolia base fees are typically <1 gwei; a full deploy + validate
    // round-trip at ~10M gas worst-case fits well under 0.01 ETH. The
    // 0.02 ETH floor leaves ~2× safety headroom while staying realistic
    // for testnet faucets that drip 0.05 ETH at a time.
    if (bal < ethers.parseEther("0.02")) {
      throw new Error(
        `[deploy-sepolia] deployer balance ${ethers.formatEther(bal)} ETH below 0.02 ETH safety floor. ` +
        "Top up via https://sepoliafaucet.com (see docs/testnet.md).",
      );
    }
  }

  const existing = readExistingManifest();
  let stack: DeployedStack | PersistedManifest;
  if (existing) {
    console.log(`[deploy-sepolia] reusing existing deployment from ${manifestPath()}`);
    console.log(`               diamond=${existing.diamond}`);
    console.log(`               (delete the file to force a fresh deploy)`);
    stack = existing;
  } else {
    // ORACLE_SIGNER_ADDRESS is honoured only when the operator also
    // provides ORACLE_SIGNER_PK_AVAILABLE=1, signalling they hold the
    // matching private key off-host. Otherwise we ignore the override
    // and default to deployer — because validate-sepolia.ts signs
    // EIP-712 oracle quotes with DEPLOYER_PRIVATE_KEY, and a mismatch
    // would silently cause every settlement on the live diamond to
    // revert with InvalidOracleSignature.
    const rawOracle = process.env.ORACLE_SIGNER_ADDRESS;
    const [signerProbe] = await ethers.getSigners();
    let oracleSignerOverride: string | undefined;
    if (rawOracle && ethers.isAddress(rawOracle)) {
      const checksummed = ethers.getAddress(rawOracle);
      if (checksummed.toLowerCase() === signerProbe.address.toLowerCase()) {
        oracleSignerOverride = checksummed;
      } else if (process.env.ORACLE_SIGNER_PK_AVAILABLE === "1") {
        oracleSignerOverride = checksummed;
        console.warn(
          `[deploy-sepolia] WARNING: oracleSigner=${checksummed} differs from deployer=${signerProbe.address}. ` +
          "validate-sepolia.ts will be unable to sign quotes against this diamond.",
        );
      } else {
        console.warn(
          `[deploy-sepolia] ignoring ORACLE_SIGNER_ADDRESS=${checksummed} (≠ deployer). ` +
          "Set ORACLE_SIGNER_PK_AVAILABLE=1 to opt out of the deployer-as-oracle default.",
        );
      }
    }
    const timeLockDelay = process.env.TIMELOCK_DELAY_SEC ? Number(process.env.TIMELOCK_DELAY_SEC) : 0;
    stack = await deployStack({ oracleSignerOverride, timeLockDelay });
  }

  if (network.name === "sepolia" && stack.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `[deploy-sepolia] manifest chainId ${stack.chainId} doesn't match Sepolia (${SEPOLIA_CHAIN_ID}). ` +
      "Wrong network selected, or manifest was produced on a different chain.",
    );
  }

  fs.mkdirSync(manifestDir(), { recursive: true });
  const out: PersistedManifest = {
    ...stack,
    network: network.name,
    deployedAt: existing?.deployedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath(), JSON.stringify(out, null, 2) + "\n");
  console.log(`[deploy-sepolia] manifest → ${manifestPath()}`);
  await writeAbis(stack);

  await maybeVerifyOnEtherscan(out);

  console.log("[deploy-sepolia] DONE — next: scripts/validate-sepolia.ts");
}

// [Task 9] In-flow Etherscan verification.
//
// Runs after the manifest is written so the verify pass sees every
// address it needs to stamp. Skipped when:
//   - the network is hardhat / localhost (no public explorer),
//   - ETHERSCAN_API_KEY is not set (the verify task would fail
//     immediately), or
//   - the operator has explicitly opted out via SKIP_ETHERSCAN_VERIFY=1.
//
// Failures here are intentionally non-fatal: a deploy that succeeded
// on-chain should not be reported as failed just because Etherscan was
// down or rate-limited. Operators can always re-run `npm run verify`
// to retry, and the per-contract status persisted into the manifest
// makes the gap auditable.
async function maybeVerifyOnEtherscan(manifest: PersistedManifest): Promise<void> {
  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("[deploy-sepolia] skipping Etherscan verification (local network)");
    return;
  }
  if (process.env.SKIP_ETHERSCAN_VERIFY === "1") {
    console.log("[deploy-sepolia] skipping Etherscan verification (SKIP_ETHERSCAN_VERIFY=1)");
    markAllSkipped(manifest, "SKIP_ETHERSCAN_VERIFY=1");
    return;
  }
  if (!process.env.ETHERSCAN_API_KEY) {
    console.log("[deploy-sepolia] skipping Etherscan verification (ETHERSCAN_API_KEY unset)");
    markAllSkipped(manifest, "ETHERSCAN_API_KEY unset");
    return;
  }
  console.log("[deploy-sepolia] running Etherscan source-verification…");
  try {
    const { failed } = await verifyDeploymentManifest({ manifestFile: manifestPath() });
    if (failed.length > 0) {
      console.warn(
        `[deploy-sepolia] ${failed.length} contract(s) failed verification: ${failed.join(", ")}. ` +
        "Re-run `npm run verify` to retry. Manifest verification status updated.",
      );
    } else {
      console.log("[deploy-sepolia] Etherscan verification complete");
    }
  } catch (e) {
    // Don't fail the deploy on a verification crash — the on-chain
    // state is already final. Surface the cause for the operator.
    console.warn(`[deploy-sepolia] verification crashed: ${(e as Error).message}`);
  }
}

// Stamp a "skipped" entry for every known contract so consumers of
// the manifest can tell verification was intentionally not attempted
// (vs. forgotten). Only fills entries that don't already have a
// terminal status from a previous run.
function markAllSkipped(manifest: PersistedManifest, reason: string): void {
  const file = manifestPath();
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedManifest & {
    verification?: Record<string, VerificationEntry>;
  };
  const verification: Record<string, VerificationEntry> = { ...(m.verification ?? {}) };
  const now = new Date().toISOString();
  const stamp = (label: string): void => {
    if (verification[label]?.status === "verified" || verification[label]?.status === "already-verified") return;
    verification[label] = { status: "skipped", message: reason, verifiedAt: now };
  };
  stamp("GSDCToken");
  stamp("DiamondCutFacet");
  stamp("Diamond");
  stamp("DiamondInit");
  stamp("MarginWallet:tgsTreasury");
  for (const name of Object.keys(manifest.facets ?? {})) stamp(name);
  for (const owner of Object.keys(manifest.partnerMarginWallets ?? {})) stamp(`MarginWallet:${owner}`);
  m.verification = verification;
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
