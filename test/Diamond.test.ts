import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFullDiamond, asFacet } from "./helpers";

describe("Diamond — cut + loupe", () => {
  it("adds + introspects all 12 facets through the proxy", async () => {
    const d = await deployFullDiamond();
    const loupe = await asFacet<any>(d.diamondAddr, "DiamondLoupeFacet");
    const facets = await loupe.facets();
    // 13 = 9 domain + DiamondCut + DiamondLoupe + [B-12] OracleGovernanceFacet + PausableFacet.
    expect(facets.length).to.equal(13);
  });

  it("facetAddress() resolves a known selector to its facet", async () => {
    const d = await deployFullDiamond();
    const loupe = await asFacet<any>(d.diamondAddr, "DiamondLoupeFacet");
    const fm = await ethers.getContractFactory("FloatManagerFacet");
    const reserveSelector = fm.interface.getFunction("reserveFloat")!.selector;
    const resolved = await loupe.facetAddress(reserveSelector);
    expect(resolved).to.equal(d.facets["FloatManagerFacet"]);
  });

  it("non-owner diamondCut reverts", async () => {
    const d = await deployFullDiamond();
    const [, attacker] = await ethers.getSigners();
    const dCut = await ethers.getContractAt("IDiamondCut", d.diamondAddr, attacker);
    await expect(dCut.diamondCut([], ethers.ZeroAddress, "0x"))
      .to.be.revertedWith("LibDiamond: must be contract owner");
  });

  it("calls to unknown selector revert with 'function does not exist'", async () => {
    const d = await deployFullDiamond();
    // Random 4-byte selector that isn't on any facet.
    await expect(
      d.oracleSigner.sendTransaction({ to: d.diamondAddr, data: "0xdeadbeef" }),
    ).to.be.revertedWith("Diamond: function does not exist");
  });
});
