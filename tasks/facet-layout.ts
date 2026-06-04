// [AD] L4.tooling.facet-layout — print the current selector → facet
// routing of a deployed Diamond. Used to verify diamond-cut outcomes
// against docs/architecture/50-storage-slot-registry.md (CR-5) and
// the facet table in docs/architecture/views/15-onchain-view.md §2.
//
// Usage:
//   npx hardhat facet-layout --diamond <address> --network <net>
//
// If --diamond is omitted, the task tries process.env.DIAMOND_ADDRESS.

import { task } from "hardhat/config";

task("facet-layout", "Print the selector -> facet map of a deployed Diamond")
  .addOptionalParam("diamond", "Diamond address (falls back to env DIAMOND_ADDRESS)")
  .setAction(async (args, hre) => {
    const diamondAddress: string =
      args.diamond || process.env.DIAMOND_ADDRESS || "";
    if (!diamondAddress) {
      throw new Error(
        "facet-layout: pass --diamond <address> or set DIAMOND_ADDRESS env var.",
      );
    }

    const loupe = await hre.ethers.getContractAt(
      "IDiamondLoupe",
      diamondAddress,
    );
    const facets: Array<{ facetAddress: string; functionSelectors: string[] }> =
      await loupe.facets();

    let totalSelectors = 0;
    console.log(`Diamond: ${diamondAddress}`);
    console.log(`Network: ${hre.network.name}`);
    console.log(`Facets : ${facets.length}`);
    console.log("");
    for (const f of facets) {
      console.log(`  facet ${f.facetAddress}`);
      console.log(`    selectors (${f.functionSelectors.length}):`);
      for (const sel of f.functionSelectors) {
        console.log(`      ${sel}`);
      }
      totalSelectors += f.functionSelectors.length;
    }
    console.log("");
    console.log(`Total selectors: ${totalSelectors}`);
    console.log(
      "Verify against docs/architecture/views/15-onchain-view.md §2 and " +
        "docs/architecture/50-storage-slot-registry.md.",
    );
  });
