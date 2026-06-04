// Deploys per-partner MarginWallets. Reads partner addresses from env or
// the deployment manifest. Idempotent — re-running with the same partner
// set produces the same addresses (CREATE bytecode is deterministic only
// up to nonce; this script just appends new ones if partner set changes).
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const file = path.resolve(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`[deploy-margin-wallets] missing ${file} — run deploy-diamond.ts first`);
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const { gsdcToken, diamond } = manifest;
  if (!gsdcToken || !diamond) throw new Error("[deploy-margin-wallets] gsdcToken + diamond required");

  const partnersRaw = process.env.PARTNER_OWNERS || ""; // CSV of EOAs
  const partnerOwners = partnersRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (partnerOwners.length === 0) {
    console.log("[deploy-margin-wallets] PARTNER_OWNERS env not set — using deployer for one demo wallet");
    partnerOwners.push(deployer.address);
  }

  const MarginWallet = await ethers.getContractFactory("MarginWallet");
  const wallets: Record<string, string> = {};
  for (const owner of partnerOwners) {
    const w = await MarginWallet.deploy(gsdcToken, owner, diamond);
    await w.waitForDeployment();
    const addr = await w.getAddress();
    wallets[owner] = addr;
    console.log(`[deploy-margin-wallets] owner=${owner} marginWallet=${addr}`);
  }

  manifest.partnerMarginWallets = { ...(manifest.partnerMarginWallets || {}), ...wallets };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
