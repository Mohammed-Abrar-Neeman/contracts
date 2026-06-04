// [Task 4 / Task 9] Etherscan source-verification driven by the manifest
// schema written by scripts/deploy-sepolia.ts.
//
// Reads contracts/deployments/<network>/manifest.json, runs
// hardhat-verify's `verify:verify` for each known contract, and stamps
// a per-contract verification status (verified / already-verified /
// failed / skipped) back into the same manifest under `verification`.
//
// As of [Task 9], verification is also invoked automatically from the
// deploy script when ETHERSCAN_API_KEY is set — this file remains the
// canonical entrypoint for re-verifying an existing deployment, and
// exposes `verifyDeploymentManifest()` for in-process callers.
import { run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

export type VerifyStatus = "verified" | "already-verified" | "failed" | "skipped";

export interface VerificationEntry {
  status: VerifyStatus;
  message?: string;
  verifiedAt: string;
}

export interface VerifyManifestShape {
  admin: string;
  gsdcToken: string;
  diamond: string;
  diamondCutFacet: string;
  diamondInit: string;
  tgsTreasuryMarginWallet: string;
  facets: Record<string, string>;
  partnerMarginWallets?: Record<string, string>;
  verification?: Record<string, VerificationEntry>;
  [k: string]: unknown;
}

export interface VerifyOptions {
  /** Absolute path to manifest.json. Defaults to deployments/<network>/manifest.json. */
  manifestFile?: string;
  /** When true, returns rather than throwing/exiting on failures. */
  noExit?: boolean;
}

export interface VerifyResult {
  results: Record<string, VerificationEntry>;
  failed: string[];
}

function defaultManifestPath(): string {
  // Prefer the new layout (deployments/<network>/manifest.json) but
  // fall back to the legacy single-file layout for older deployments.
  const newP = path.resolve(__dirname, "..", "deployments", network.name, "manifest.json");
  if (fs.existsSync(newP)) return newP;
  const oldP = path.resolve(__dirname, "..", "deployments", `${network.name}.json`);
  if (fs.existsSync(oldP)) return oldP;
  throw new Error(`[verify] no manifest at ${newP} or ${oldP}. Run deploy:sepolia first.`);
}

async function verifyOne(
  results: Record<string, VerificationEntry>,
  label: string,
  addr: string | undefined,
  args: unknown[],
): Promise<void> {
  if (!addr) {
    results[label] = { status: "skipped", message: "no address", verifiedAt: new Date().toISOString() };
    return;
  }
  try {
    await run("verify:verify", { address: addr, constructorArguments: args });
    console.log(`[verify] verified ${label} @ ${addr}`);
    results[label] = { status: "verified", verifiedAt: new Date().toISOString() };
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    if (/already verified/i.test(msg)) {
      console.log(`[verify] already-verified ${label} @ ${addr}`);
      results[label] = { status: "already-verified", verifiedAt: new Date().toISOString() };
    } else {
      console.log(`[verify] FAILED ${label} @ ${addr} — ${msg}`);
      results[label] = { status: "failed", message: msg, verifiedAt: new Date().toISOString() };
    }
  }
}

/**
 * Verify every contract referenced by the manifest at `opts.manifestFile`
 * (or the default `deployments/<network>/manifest.json`) on Etherscan,
 * persisting per-contract status into the manifest's `verification`
 * field. Safe to call repeatedly — already-verified contracts short-
 * circuit on Etherscan's side and are recorded as `already-verified`.
 *
 * Returns the merged status map plus the list of labels that failed,
 * so callers (e.g. `deploy-sepolia.ts`) can decide whether to exit
 * non-zero without taking down the surrounding deploy flow.
 */
export async function verifyDeploymentManifest(opts: VerifyOptions = {}): Promise<VerifyResult> {
  const file = opts.manifestFile ?? defaultManifestPath();
  console.log(`[verify] using manifest ${file}`);
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as VerifyManifestShape;
  const results: Record<string, VerificationEntry> = { ...(m.verification ?? {}) };

  await verifyOne(results, "GSDCToken", m.gsdcToken, [m.admin]);
  await verifyOne(results, "DiamondCutFacet", m.diamondCutFacet, []);
  await verifyOne(results, "Diamond", m.diamond, [m.admin, m.diamondCutFacet]);
  await verifyOne(results, "DiamondInit", m.diamondInit, []);
  await verifyOne(results, "MarginWallet:tgsTreasury", m.tgsTreasuryMarginWallet, [m.gsdcToken, m.admin, m.diamond]);
  for (const [name, addr] of Object.entries(m.facets ?? {})) {
    await verifyOne(results, name, addr, []);
  }
  for (const [owner, addr] of Object.entries(m.partnerMarginWallets ?? {})) {
    await verifyOne(results, `MarginWallet:${owner}`, addr, [m.gsdcToken, owner, m.diamond]);
  }

  // Persist verification status alongside the manifest.
  m.verification = results;
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
  console.log(`[verify] verification status written → ${file}`);

  const failed = Object.entries(results)
    .filter(([, v]) => v.status === "failed")
    .map(([k]) => k);
  return { results, failed };
}

async function main(): Promise<void> {
  const { failed, results } = await verifyDeploymentManifest();
  if (failed.length > 0) {
    console.error(`[verify] ${failed.length} contract(s) failed verification:`);
    for (const k of failed) console.error(`  - ${k}: ${results[k].message}`);
    process.exit(2);
  }
}

// Only run main() when executed as a script (not when imported by
// deploy-sepolia.ts). hardhat run sets require.main === module.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
