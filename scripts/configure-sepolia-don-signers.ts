// B-13 §2 — Sepolia DON signer whitelist configuration.
//
// Post-deployment companion to deploy-sepolia.ts. Reads the deployed
// Diamond address from contracts/deployments/sepolia.json, validates the
// DON signer list provided via env, calls
// OracleGovernanceFacet.setOracleSigners([5 addresses], threshold) under
// the admin signer, and writes the addresses back into the manifest.
//
// Run via:
//   yarn hardhat run scripts/configure-sepolia-don-signers.ts --network sepolia
//
// Required env:
//   SEPOLIA_RPC_URL          — Sepolia node URL
//   DEPLOYER_PRIVATE_KEY     — admin/deployer key (same as deploy-sepolia.ts)
//   DON_SIGNER_1_ADDRESS .. DON_SIGNER_5_ADDRESS  — public addresses of
//                              the 5 DON committee members (HSM-backed
//                              in production — addresses only, no keys
//                              in the audited tree).
//   DON_THRESHOLD            — integer ≥ 1, ≤ signers.length (default 3).
//
// [B-13 §0] This script ships in B-13 but does NOT execute as part of
// the tier. Ayrton runs it once after deploy-sepolia.ts, post-CertiK.
//
// [GAP — Phase 2] Once the DAO governance contract lands, setOracleSigners
// is gated behind the DAO timelock and the admin can no longer call it
// directly. This script becomes "submit DAO proposal" not "call admin
// function". The on-chain mechanism is identical; only the access
// modifier changes (one line in OracleGovernanceFacet.sol).

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main(): Promise<void> {
  if (network.name !== "sepolia") {
    throw new Error(
      `[configure-don] expected --network sepolia, got "${network.name}"`,
    );
  }

  const manifestPath = path.resolve(__dirname, "..", "deployments", "sepolia.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[configure-don] missing ${manifestPath} — run deploy-sepolia.ts first`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  console.log(`[configure-don] diamond @ ${manifest.diamond}`);

  // Load + validate signer list.
  const addrs: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const a = process.env[`DON_SIGNER_${i}_ADDRESS`];
    if (a) {
      if (!ethers.isAddress(a)) {
        throw new Error(`[configure-don] DON_SIGNER_${i}_ADDRESS is not a valid address: ${a}`);
      }
      addrs.push(ethers.getAddress(a));
    }
  }
  if (addrs.length === 0) {
    throw new Error(`[configure-don] no DON_SIGNER_N_ADDRESS env vars set — refusing to clear whitelist`);
  }
  // Detect dups.
  if (new Set(addrs.map((a) => a.toLowerCase())).size !== addrs.length) {
    throw new Error(`[configure-don] duplicate addresses in DON_SIGNER_*_ADDRESS list`);
  }

  const threshold = Number(process.env.DON_THRESHOLD ?? "3");
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > addrs.length) {
    throw new Error(`[configure-don] DON_THRESHOLD ${threshold} invalid (need 1..${addrs.length})`);
  }
  if (addrs.length > 10) {
    throw new Error(`[configure-don] signers.length ${addrs.length} > MAX_SIGNERS (10)`);
  }

  console.log(`[configure-don] setting ${addrs.length} signers, threshold=${threshold}:`);
  for (const a of addrs) console.log(`               ${a}`);

  const [admin] = await ethers.getSigners();
  console.log(`[configure-don] admin signer = ${admin.address}`);
  if (admin.address.toLowerCase() !== (manifest.admin ?? "").toLowerCase()) {
    console.warn(`[configure-don] WARN — admin signer (${admin.address}) does not match manifest.admin (${manifest.admin}). Tx will revert if admin gate fails.`);
  }

  // [B-16 β-2] Immediate-effect setOracleSigners was removed by audit
  // NEW-010. Operator must run this script TWICE: once to queue, then —
  // after the on-chain timeLockDelay elapses — invoke
  // TimeLockControllerFacet.executeChange(changeId) from the admin EOA.
  const gov = await ethers.getContractAt("OracleGovernanceFacet", manifest.diamond);
  const tx = await gov.queueOracleSignersChange(addrs, threshold);
  const rc = await tx.wait();
  console.log(`[configure-don] queueOracleSignersChange tx=${tx.hash} status=${rc?.status}`);
  console.log(`[configure-don] NOTE: rotation is QUEUED — wait timeLockDelay then call executeChange(changeId)`);
  return;
  // eslint-disable-next-line no-unreachable

  // Verify on-chain state matches expectation.
  const onChain = await gov.getOracleSigners();
  const onChainThreshold = await gov.getOracleThreshold();
  if (onChain.length !== addrs.length || Number(onChainThreshold) !== threshold) {
    throw new Error(`[configure-don] post-call mismatch: on-chain=${onChain.length}/${onChainThreshold} expected=${addrs.length}/${threshold}`);
  }
  for (const a of addrs) {
    if (!onChain.map((x: string) => x.toLowerCase()).includes(a.toLowerCase())) {
      throw new Error(`[configure-don] post-call missing signer ${a}`);
    }
  }
  console.log(`[configure-don] verified on-chain state matches input`);

  manifest.donSigners = addrs;
  manifest.donThreshold = threshold;
  manifest.donConfiguredAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[configure-don] manifest updated → ${manifestPath}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
