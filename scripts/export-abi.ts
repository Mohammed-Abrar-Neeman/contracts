// Exports compiled ABIs to /app/backend/src/chain/abi/ for B-5 DiamondClient.
import * as fs from "fs";
import * as path from "path";

const TARGETS = [
  "GSDCToken",
  "Diamond",
  "DiamondCutFacet",
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
  // [B-12 §3] OracleGovernanceFacet — DON whitelist + threshold mgmt.
  "OracleGovernanceFacet",
  "MarginWallet",
  "ISettlementDiamond",
  "IEIP3009",
];

async function main() {
  const artifactsDir = path.resolve(__dirname, "..", "artifacts", "contracts");
  const outDir = path.resolve(__dirname, "..", "..", "backend", "src", "chain", "abi");
  fs.mkdirSync(outDir, { recursive: true });

  let written = 0;
  for (const name of TARGETS) {
    const found = findArtifact(artifactsDir, name);
    if (!found) {
      console.warn(`[export-abi] artifact missing for ${name}`);
      continue;
    }
    const artifact = JSON.parse(fs.readFileSync(found, "utf8"));
    fs.writeFileSync(
      path.join(outDir, `${name}.json`),
      JSON.stringify({ contractName: name, abi: artifact.abi }, null, 2),
    );
    written++;
  }
  console.log(`[export-abi] wrote ${written} ABIs → ${outDir}`);
}

function findArtifact(dir: string, name: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const r = findArtifact(full, name);
      if (r) return r;
    } else if (entry.name === `${name}.json` && full.includes(`${name}.sol`)) {
      return full;
    }
  }
  return null;
}

main().catch((e) => { console.error(e); process.exit(1); });
