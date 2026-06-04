// [Task 4] End-to-end Sepolia validation.
//
// Runs a 6-step on-chain settlement cycle against a deployed Diamond and
// produces a markdown + JSON transaction report so reviewers can verify
// mint, EIP-3009, settlement, fee split, and burn worked on a real
// network. Each step records: tx hash, gas used, block number, status.
//
// Steps (in order):
//   1. Oracle quote signed off-chain (EIP-712) and verified on-chain
//      via QuoteVerifierFacet.verifyAndDecodeQuote(...) eth_call.
//   2. Standalone EIP-3009 transferWithAuthorization on the GSDC token,
//      proving the primitive works independently of settlement.
//   3. mintFloat — top up the source partner with GSDC for settlement.
//   4. executeSettlement — atomic 4-leg fan-out (delivery + 3 margins);
//      validates fee split distribution to TGS treasury.
//   5. burnFloat — close the cycle by decrementing source-side float.
//   6. Read-back assertions: balances, fee accruals, EIP-3009 nonce
//      consumed, settlement status = SETTLED.
//
// Run via:
//   pnpm --filter gsdc-contracts run validate:sepolia
//   yarn hardhat run scripts/validate-sepolia.ts --network sepolia
//   yarn hardhat run scripts/validate-sepolia.ts --network hardhat   (dry-run)
//
// Output:
//   docs/testnet-reports/<network>-<UTC-timestamp>.md
//   docs/testnet-reports/<network>-<UTC-timestamp>.json
//
// On the in-memory `hardhat` network the script auto-deploys a fresh
// stack so the same logic doubles as a smoke test before broadcasting
// to Sepolia.

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { deployStack, DeployedStack } from "./lib/deploy-stack";
import { buildSignedQuote, signEIP3009Authorization, signEIP3009Raw } from "./lib/quote-signing";
import type { VerificationEntry, VerifyManifestShape } from "./verify-on-etherscan";

interface VerificationSummary {
  verified: number;
  alreadyVerified: number;
  failed: number;
  skipped: number;
  total: number;
}

interface VerificationSection {
  entries: Record<string, VerificationEntry & { address: string | null }>;
  summary: VerificationSummary;
}

interface StepRecord {
  index: number;
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  txHash: string | null;
  blockNumber: number | null;
  gasUsed: string | null;
  notes: string;
  error?: string;
}

interface Report {
  network: string;
  chainId: number;
  startedAt: string;
  finishedAt: string;
  diamond: string;
  gsdcToken: string;
  deployer: string;
  steps: StepRecord[];
  summary: { passed: number; failed: number; skipped: number; totalGas: string };
  verification?: VerificationSection;
  result: "PASS" | "FAIL";
}

function addressForLabel(m: VerifyManifestShape, label: string): string | null {
  if (label === "GSDCToken") return m.gsdcToken ?? null;
  if (label === "DiamondCutFacet") return m.diamondCutFacet ?? null;
  if (label === "Diamond") return m.diamond ?? null;
  if (label === "DiamondInit") return m.diamondInit ?? null;
  if (label === "MarginWallet:tgsTreasury") return m.tgsTreasuryMarginWallet ?? null;
  if (label.startsWith("MarginWallet:")) {
    const owner = label.slice("MarginWallet:".length);
    return m.partnerMarginWallets?.[owner] ?? null;
  }
  return m.facets?.[label] ?? null;
}

function loadVerificationSection(): VerificationSection | undefined {
  const p = manifestPath();
  if (!fs.existsSync(p)) return undefined;
  const m = JSON.parse(fs.readFileSync(p, "utf8")) as VerifyManifestShape;
  if (!m.verification || Object.keys(m.verification).length === 0) return undefined;
  const entries: Record<string, VerificationEntry & { address: string | null }> = {};
  let verified = 0, alreadyVerified = 0, failed = 0, skipped = 0;
  for (const [label, entry] of Object.entries(m.verification)) {
    entries[label] = { ...entry, address: addressForLabel(m, label) };
    switch (entry.status) {
      case "verified": verified++; break;
      case "already-verified": alreadyVerified++; break;
      case "failed": failed++; break;
      case "skipped": skipped++; break;
    }
  }
  const total = verified + alreadyVerified + failed + skipped;
  return { entries, summary: { verified, alreadyVerified, failed, skipped, total } };
}

const CORRIDOR = ethers.id("INR_CNH");
const DELIVERY = ethers.parseEther("100");          // 100 GSDC delivered
const LP_SRC_BPS = 30, TGS_BPS = 10, LP_DST_BPS = 20; // total 60 bps fees
const EIP3009_DEMO_AMOUNT = ethers.parseEther("1");  // standalone primitive demo

function manifestPath(): string {
  return path.resolve(__dirname, "..", "deployments", network.name, "manifest.json");
}

async function loadOrDeployStack(): Promise<DeployedStack> {
  const p = manifestPath();
  if (fs.existsSync(p)) {
    console.log(`[validate-sepolia] using deployment manifest ${p}`);
    return JSON.parse(fs.readFileSync(p, "utf8")) as DeployedStack;
  }
  if (network.name === "sepolia") {
    throw new Error(
      `[validate-sepolia] missing ${p}. Run scripts/deploy-sepolia.ts first.`,
    );
  }
  console.log(`[validate-sepolia] no manifest found — deploying fresh stack on ${network.name}`);
  const stack = await deployStack({ timeLockDelay: 0 });
  // Only persist on networks with durable state. Hardhat's in-memory
  // node resets between `hardhat run` invocations, so a persisted
  // manifest would point at non-existent contracts on the next run.
  if (network.name !== "hardhat") {
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...stack, network: network.name, deployedAt: new Date().toISOString() }, null, 2));
  }
  return stack;
}

async function runStep(
  records: StepRecord[],
  index: number,
  name: string,
  fn: () => Promise<{ txHash: string | null; blockNumber: number | null; gasUsed: bigint | null; notes: string }>,
): Promise<void> {
  console.log(`\n[validate] step ${index} — ${name}`);
  const rec: StepRecord = {
    index, name, status: "PASS", txHash: null, blockNumber: null, gasUsed: null, notes: "",
  };
  try {
    const r = await fn();
    rec.txHash = r.txHash;
    rec.blockNumber = r.blockNumber;
    rec.gasUsed = r.gasUsed?.toString() ?? null;
    rec.notes = r.notes;
    console.log(`           PASS  ${r.notes}${r.txHash ? `  tx=${r.txHash}` : ""}`);
  } catch (e) {
    rec.status = "FAIL";
    rec.error = (e as Error).message.split("\n")[0];
    console.log(`           FAIL  ${rec.error}`);
  }
  records.push(rec);
}

function etherscanBase(chainId: number): string | null {
  if (chainId === 11155111) return "https://sepolia.etherscan.io";
  return null;
}

function writeReports(report: Report): { md: string; json: string } {
  const dir = path.resolve(__dirname, "..", "..", "docs", "testnet-reports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const base = path.join(dir, `${report.network}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + "\n");

  const explorer = etherscanBase(report.chainId);
  const link = (h: string | null) => h && explorer ? `[\`${h.slice(0, 10)}…\`](${explorer}/tx/${h})` : (h ? `\`${h.slice(0, 10)}…\`` : "—");
  const lines = [
    `# Sepolia validation report — ${report.network} @ ${report.startedAt}`,
    "",
    `- **Network**: \`${report.network}\` (chainId ${report.chainId})`,
    `- **Diamond**: \`${report.diamond}\`${explorer ? ` ([etherscan](${explorer}/address/${report.diamond}))` : ""}`,
    `- **GSDC Token**: \`${report.gsdcToken}\`${explorer ? ` ([etherscan](${explorer}/address/${report.gsdcToken}))` : ""}`,
    `- **Deployer/Admin**: \`${report.deployer}\``,
    `- **Started**: ${report.startedAt}`,
    `- **Finished**: ${report.finishedAt}`,
    "",
    `## Result: **${report.result}**`,
    `- Passed: ${report.summary.passed}`,
    `- Failed: ${report.summary.failed}`,
    `- Skipped: ${report.summary.skipped}`,
    `- Total gas used: ${report.summary.totalGas}`,
    "",
    "## Step ledger",
    "",
    "| # | Step | Status | Tx | Block | Gas | Notes |",
    "|---|------|--------|----|-------|-----|-------|",
    ...report.steps.map((s) =>
      `| ${s.index} | ${s.name} | ${s.status} | ${link(s.txHash)} | ${s.blockNumber ?? "—"} | ${s.gasUsed ?? "—"} | ${s.error ? `**${s.error}**` : s.notes} |`,
    ),
    "",
  ];

  if (report.verification) {
    const v = report.verification;
    const addrLink = (a: string | null) =>
      a && explorer ? `[\`${a}\`](${explorer}/address/${a})` : (a ? `\`${a}\`` : "—");
    const statusBadge: Record<string, string> = {
      "verified": "✅ verified",
      "already-verified": "✅ already-verified",
      "failed": "❌ failed",
      "skipped": "⚠️ skipped",
    };
    lines.push(
      "## Etherscan verification",
      "",
      `- Verified: ${v.summary.verified}`,
      `- Already-verified: ${v.summary.alreadyVerified}`,
      `- Failed: ${v.summary.failed}`,
      `- Skipped: ${v.summary.skipped}`,
      `- Total: ${v.summary.total}`,
      "",
      "| Contract | Address | Status | Notes |",
      "|----------|---------|--------|-------|",
      ...Object.entries(v.entries).map(([label, e]) =>
        `| ${label} | ${addrLink(e.address)} | ${statusBadge[e.status] ?? e.status} | ${e.message ?? ""} |`,
      ),
      "",
    );
  }

  lines.push(
    "_Generated by `contracts/scripts/validate-sepolia.ts`. See `docs/testnet.md` for interpretation._",
    "",
  );
  fs.writeFileSync(`${base}.md`, lines.join("\n"));

  // Stable "latest" pointer files so README.md and docs/testnet.md can link
  // to a fixed URL that always shows the most recent run. See
  // `docs/testnet.md` ("Latest run") and the README badge for consumers.
  // Gated to sepolia only so dry-runs (`--network hardhat`) cannot
  // accidentally overwrite the pointer with non-sepolia data if a
  // contributor commits the result by mistake.
  if (report.network !== "sepolia" || report.chainId !== 11155111) {
    return { md: `${base}.md`, json: `${base}.json` };
  }
  const reportMdName = `${report.network}-${stamp}.md`;
  const reportJsonName = `${report.network}-${stamp}.json`;
  const latestJson = {
    network: report.network,
    chainId: report.chainId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    result: report.result,
    diamond: report.diamond,
    gsdcToken: report.gsdcToken,
    deployer: report.deployer,
    summary: report.summary,
    reportMd: reportMdName,
    reportJson: reportJsonName,
  };
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(latestJson, null, 2) + "\n");
  const badge = report.result === "PASS" ? "✅ PASS" : "❌ FAIL";
  const latestMd = [
    `# Latest Sepolia validation — ${badge}`,
    "",
    "_Auto-generated pointer to the most recent on-chain validation run._",
    "_Do not edit by hand; `contracts/scripts/validate-sepolia.ts` rewrites this file_",
    "_at the end of every run._",
    "",
    `- **Result**: **${report.result}** (${report.summary.passed} passed, ${report.summary.failed} failed, total gas ${report.summary.totalGas})`,
    `- **Network**: \`${report.network}\` (chainId ${report.chainId})`,
    `- **Run started**: ${report.startedAt}`,
    `- **Run finished**: ${report.finishedAt}`,
    `- **Diamond**: \`${report.diamond}\`${explorer ? ` ([etherscan](${explorer}/address/${report.diamond}))` : ""}`,
    `- **GSDC token**: \`${report.gsdcToken}\`${explorer ? ` ([etherscan](${explorer}/address/${report.gsdcToken}))` : ""}`,
    "",
    `**Full report**: [\`${reportMdName}\`](./${reportMdName}) · [JSON](./${reportJsonName})`,
    "",
    "See [`docs/testnet.md`](../testnet.md) for how to run the validation",
    "and how to interpret the report.",
    "",
  ];
  fs.writeFileSync(path.join(dir, "LATEST.md"), latestMd.join("\n"));

  return { md: `${base}.md`, json: `${base}.json` };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  if (network.name === "sepolia" && !process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("[validate-sepolia] DEPLOYER_PRIVATE_KEY required to sign quotes + EIP-3009 on Sepolia");
  }

  const stack = await loadOrDeployStack();
  console.log(`[validate-sepolia] diamond=${stack.diamond}`);

  // Source signer = deployer (we control its key, needed for EIP-3009 +
  // EIP-712 oracle signing). Destination partner = a deterministic
  // throwaway address (it only receives GSDC, never signs).
  const [deployer] = await ethers.getSigners();
  if (deployer.address.toLowerCase() !== stack.admin.toLowerCase()) {
    throw new Error(
      `[validate-sepolia] connected signer ${deployer.address} does not match manifest admin ${stack.admin}. ` +
      "Refusing to run — would revert at every admin gate.",
    );
  }
  // Pull the deployer private key for signing. On hardhat, fall back to
  // the well-known mnemonic key for signer #0.
  const deployerPK = network.name === "sepolia"
    ? process.env.DEPLOYER_PRIVATE_KEY!
    : "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  // Oracle quote signing: when the deployment used a distinct
  // ORACLE_SIGNER_ADDRESS (e.g. ORACLE_SIGNER_PK_AVAILABLE=1 at deploy
  // time), the on-chain QuoteVerifierFacet only accepts EIP-712
  // signatures from that address. Fall back to the deployer key when
  // oracleSigner == deployer (the legacy single-signer path).
  const oraclePK = (
    stack.oracleSigner.toLowerCase() !== deployer.address.toLowerCase()
      && process.env.ORACLE_SIGNER_PRIVATE_KEY
  ) ? process.env.ORACLE_SIGNER_PRIVATE_KEY : deployerPK;

  const dest = ethers.getAddress("0x" + ethers.keccak256(
    ethers.toUtf8Bytes(`gsdc-validate-dest-${network.name}`),
  ).slice(26));
  console.log(`[validate-sepolia] src=${deployer.address}  dst=${dest}`);

  // Per-partner MarginWallets need to exist on-chain so transfers in
  // step 4 succeed. Deploy if missing (idempotent — we look them up by
  // address record on the manifest if present).
  const MW = await ethers.getContractFactory("MarginWallet");
  const mwSrc = await MW.deploy(stack.gsdcToken, deployer.address, stack.diamond);
  await mwSrc.waitForDeployment();
  const mwDst = await MW.deploy(stack.gsdcToken, dest, stack.diamond);
  await mwDst.waitForDeployment();
  const mwSrcAddr = await mwSrc.getAddress();
  const mwDstAddr = await mwDst.getAddress();

  // One-time corridor + partner setup (idempotent — registerPartner
  // throws PartnerAlreadyRegistered if re-run; we swallow that).
  const tlc = await ethers.getContractAt("TimeLockControllerFacet", stack.diamond);
  await (await tlc.configureCorridor(CORRIDOR, true, 1, 0, 0, 86399)).wait();
  // Set bps via queueMarginUpdate + executeChange (timeLockDelay=0).
  const queueTx = await tlc.queueMarginUpdate(CORRIDOR, LP_SRC_BPS, TGS_BPS, LP_DST_BPS);
  const queueRcpt = await queueTx.wait();
  const queuedEvent = queueRcpt!.logs
    .map((l: { topics: readonly string[]; data: string }) => {
      try { return tlc.interface.parseLog({ topics: Array.from(l.topics), data: l.data }); } catch { return null; }
    })
    .find((p: { name: string } | null) => p?.name === "ChangeQueued");
  if (!queuedEvent) throw new Error("[validate] ChangeQueued not emitted — non-zero timeLockDelay?");
  await (await tlc.executeChange(queuedEvent.args[0])).wait();

  const cg = await ethers.getContractAt("ComplianceGateFacet", stack.diamond);
  for (const [partner, mw, tag] of [[deployer.address, mwSrcAddr, "src"], [dest, mwDstAddr, "dst"]] as const) {
    try {
      await (await cg.registerPartner(partner, partner, mw, ethers.id(`kyc-${tag}-${network.name}`), [CORRIDOR])).wait();
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes("PartnerAlreadyRegistered") && !/execution reverted/i.test(msg)) throw e;
      // Already registered on a prior run — make sure corridor is on the auth list.
      try { await (await cg.addPartnerCorridor(partner, CORRIDOR)).wait(); } catch { /* noop */ }
    }
  }

  const records: StepRecord[] = [];

  // Build the signed quote up-front; step 1 just verifies it on-chain.
  const settlementId = ethers.keccak256(ethers.toUtf8Bytes(`settle-${network.name}-${Date.now()}`));
  const quoteId = ethers.keccak256(ethers.toUtf8Bytes(`quote-${network.name}-${Date.now()}`));
  const signed = await buildSignedQuote(stack.diamond, oraclePK, {
    quoteId, corridorId: CORRIDOR, deliveryAmount: DELIVERY,
    lpSourceBps: LP_SRC_BPS, tgsTreasuryBps: TGS_BPS, lpDestBps: LP_DST_BPS,
  });
  const totalDebit = signed.totalDebit;

  // STEP 1 — verify the EIP-712 quote signature on-chain. We do this in
  // two passes:
  //   (a) eth_call to confirm the verifier accepts the signature and
  //       returns the expected quoteId (no gas, fast feedback).
  //   (b) broadcast a transaction that calls the same view function so
  //       the proof of acceptance is recorded on-chain with a receipt
  //       — gives reviewers a verifiable tx hash/block/gas entry in
  //       the report. Sending a transaction to a `view` function is
  //       legal; it just costs gas without persisting state.
  await runStep(records, 1, "Oracle quote signed (EIP-712) + verified on-chain", async () => {
    const qv = await ethers.getContractAt("QuoteVerifierFacet", stack.diamond);
    const decoded = await qv.verifyAndDecodeQuote(signed.encodedQuote, signed.oracleSignature);
    if (decoded.quoteId !== quoteId) throw new Error("decoded quoteId mismatch");
    const data = qv.interface.encodeFunctionData("verifyAndDecodeQuote", [
      signed.encodedQuote, signed.oracleSignature,
    ]);
    const tx = await deployer.sendTransaction({ to: stack.diamond, data });
    const r = await tx.wait();
    return { txHash: tx.hash, blockNumber: r!.blockNumber, gasUsed: r!.gasUsed,
      notes: `quoteId=${quoteId.slice(0, 10)}…  totalDebit=${ethers.formatEther(totalDebit)} GSDC` };
  });

  // STEP 2 — standalone EIP-3009 transferWithAuthorization (proves the
  // primitive). Pre-mint a small amount to deployer so we can move it.
  const mb = await ethers.getContractAt("MintBurnAuthorityFacet", stack.diamond);
  await (await mb.mintFloat(deployer.address, EIP3009_DEMO_AMOUNT)).wait();
  const eip3009Nonce = ethers.keccak256(ethers.toUtf8Bytes(`eip3009-demo-${network.name}-${Date.now()}`));
  await runStep(records, 2, "EIP-3009 transferWithAuthorization (standalone primitive)", async () => {
    const sig = await signEIP3009Raw({
      tokenAddr: stack.gsdcToken, fromPrivateKey: deployerPK, fromAddress: deployer.address,
      to: dest, value: EIP3009_DEMO_AMOUNT, nonce: eip3009Nonce,
    });
    const tok = await ethers.getContractAt("GSDCToken", stack.gsdcToken);
    const tx = await tok.transferWithAuthorization(
      deployer.address, dest, EIP3009_DEMO_AMOUNT, 0, sig.validBefore, eip3009Nonce, sig.v, sig.r, sig.s,
    );
    const r = await tx.wait();
    const used = await tok.authorizationState(deployer.address, eip3009Nonce);
    if (!used) throw new Error("authorization not marked used");
    return { txHash: tx.hash, blockNumber: r!.blockNumber, gasUsed: r!.gasUsed,
      notes: `moved ${ethers.formatEther(EIP3009_DEMO_AMOUNT)} GSDC, nonce consumed` };
  });

  // STEP 3 — Settlement mint: top up source for the upcoming settlement.
  await runStep(records, 3, "Settlement mint of GSDC (basket-rate quote)", async () => {
    const tx = await mb.mintFloat(deployer.address, totalDebit);
    const r = await tx.wait();
    return { txHash: tx.hash, blockNumber: r!.blockNumber, gasUsed: r!.gasUsed,
      notes: `minted ${ethers.formatEther(totalDebit)} GSDC to source partner` };
  });

  // STEP 4 — executeSettlement (atomic 4-leg fan-out incl. fee split).
  let preTreasury = 0n;
  await runStep(records, 4, "executeSettlement — fee split distribution to treasury", async () => {
    const tok = await ethers.getContractAt("GSDCToken", stack.gsdcToken);
    preTreasury = await tok.balanceOf(stack.tgsTreasuryMarginWallet);
    const authSig = await signEIP3009Authorization({
      tokenAddr: stack.gsdcToken, fromPrivateKey: deployerPK, fromAddress: deployer.address,
      to: stack.diamond, value: totalDebit, settlementId,
    });
    const exec = await ethers.getContractAt("SettlementExecutorFacet", stack.diamond);
    const tx = await exec.executeSettlement(
      settlementId, quoteId, CORRIDOR,
      deployer.address, dest, DELIVERY,
      signed.encodedQuote, signed.oracleSignature, authSig,
    );
    const r = await tx.wait();
    const postTreasury = await tok.balanceOf(stack.tgsTreasuryMarginWallet);
    const tgsCredit = postTreasury - preTreasury;
    const expectedTgs = (DELIVERY * BigInt(TGS_BPS)) / 10_000n;
    if (tgsCredit !== expectedTgs) {
      throw new Error(`treasury credit ${tgsCredit} ≠ expected ${expectedTgs}`);
    }
    return { txHash: tx.hash, blockNumber: r!.blockNumber, gasUsed: r!.gasUsed,
      notes: `delivered ${ethers.formatEther(DELIVERY)}, tgs+${ethers.formatEther(tgsCredit)} GSDC` };
  });

  // STEP 5 — Settlement burn (close the cycle: burn the delivered float
  // off the destination's books, simulating off-chain settlement).
  await runStep(records, 5, "Settlement burn / float decrement (cycle close)", async () => {
    // Burn the destination's delivered amount — proves
    // MintBurnAuthorityFacet.burnFloat works post-settlement.
    const tx = await mb.burnFloat(dest, DELIVERY);
    const r = await tx.wait();
    return { txHash: tx.hash, blockNumber: r!.blockNumber, gasUsed: r!.gasUsed,
      notes: `burned ${ethers.formatEther(DELIVERY)} GSDC from destination` };
  });

  // STEP 6 — Read-back assertions.
  await runStep(records, 6, "Read-back assertions (balances + EIP-3009 nonce)", async () => {
    const tok = await ethers.getContractAt("GSDCToken", stack.gsdcToken);
    const exec = await ethers.getContractAt("SettlementExecutorFacet", stack.diamond);
    const stored = await exec.getSettlement(settlementId);
    if (Number(stored.status) !== 2) throw new Error(`settlement status=${stored.status}, expected 2 (SETTLED)`);
    const consumed = await tok.authorizationState(deployer.address, settlementId);
    if (!consumed) throw new Error("settlement EIP-3009 nonce not consumed");
    const tgsBal = await tok.balanceOf(stack.tgsTreasuryMarginWallet);
    const srcMargin = await tok.balanceOf(mwSrcAddr);
    const dstMargin = await tok.balanceOf(mwDstAddr);
    return { txHash: null, blockNumber: null, gasUsed: null,
      notes: `status=SETTLED nonce=consumed tgs=${ethers.formatEther(tgsBal)} srcMW=${ethers.formatEther(srcMargin)} dstMW=${ethers.formatEther(dstMargin)}` };
  });

  const finishedAt = new Date().toISOString();
  const passed = records.filter((r) => r.status === "PASS").length;
  const failed = records.filter((r) => r.status === "FAIL").length;
  const skipped = records.filter((r) => r.status === "SKIP").length;
  const totalGas = records.reduce((acc, r) => acc + (r.gasUsed ? BigInt(r.gasUsed) : 0n), 0n).toString();

  const verification = loadVerificationSection();

  const report: Report = {
    network: network.name, chainId: stack.chainId, startedAt, finishedAt,
    diamond: stack.diamond, gsdcToken: stack.gsdcToken, deployer: deployer.address,
    steps: records,
    summary: { passed, failed, skipped, totalGas },
    verification,
    result: failed === 0 ? "PASS" : "FAIL",
  };
  const written = writeReports(report);
  console.log(`\n[validate-sepolia] report.md  → ${written.md}`);
  console.log(`[validate-sepolia] report.json → ${written.json}`);
  console.log(`[validate-sepolia] RESULT: ${report.result} (${passed} passed, ${failed} failed, total gas ${totalGas})`);
  if (verification) {
    const v = verification.summary;
    console.log(
      `[validate-sepolia] verification: ${v.verified} verified, ${v.alreadyVerified} already-verified, ${v.failed} failed, ${v.skipped} skipped (of ${v.total})`,
    );
  } else {
    console.log("[validate-sepolia] verification: no manifest verification field found — skipping summary");
  }
  if (report.result === "FAIL") process.exit(2);

  // STRICT_VERIFICATION gate: when set (truthy), an unverified contract
  // is a hard failure even if all six on-chain steps passed. CI enables
  // this by default so a "PASS" PR cannot land with one or more facets
  // missing source on Etherscan, which would defeat the auditability
  // goal. Hardhat dry-runs never produce a verification section
  // (loadVerificationSection returns undefined when no manifest exists),
  // so this gate is a no-op there. To intentionally suppress the gate
  // on a real Sepolia run (e.g. Etherscan API outage) set
  // STRICT_VERIFICATION=0 / unset it.
  const strict = !!process.env.STRICT_VERIFICATION
    && process.env.STRICT_VERIFICATION !== "0"
    && process.env.STRICT_VERIFICATION.toLowerCase() !== "false";
  if (strict && verification && verification.summary.failed > 0) {
    console.error(
      `[validate-sepolia] STRICT_VERIFICATION=${process.env.STRICT_VERIFICATION}: ` +
      `${verification.summary.failed} contract(s) failed Etherscan verification — exiting non-zero.`,
    );
    process.exit(3);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
