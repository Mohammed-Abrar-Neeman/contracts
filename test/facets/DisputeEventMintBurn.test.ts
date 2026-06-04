import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFullDiamond, asFacet } from "../helpers";

describe("DisputeResolverFacet + EventEmitterFacet + MintBurnAuthorityFacet", () => {
  it("disputeSettlement reverts on unknown settlement", async () => {
    const d = await deployFullDiamond();
    const dr = await asFacet<any>(d.diamondAddr, "DisputeResolverFacet");
    await expect(dr.disputeSettlement(ethers.id("none"), "missing"))
      .to.be.revertedWithCustomError(dr, "SettlementNotFound");
  });

  it("EventEmitter — emitSettlementBroadcast emits the event", async () => {
    const d = await deployFullDiamond();
    const ee = await asFacet<any>(d.diamondAddr, "EventEmitterFacet");
    const sid = ethers.id("s");
    const cid = ethers.id("c");
    await expect(ee.emitSettlementBroadcast(sid, cid, "0xdeadbeef"))
      .to.emit(ee, "SettlementBroadcast").withArgs(sid, cid, "0xdeadbeef");
  });

  it("MintBurn — mintFloat increases ERC20 balance; non-admin cannot mint", async () => {
    const d = await deployFullDiamond();
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const [_, __, beneficiary] = await ethers.getSigners();
    await mb.mintFloat(beneficiary.address, ethers.parseEther("7"));
    expect(await d.gsdcToken.balanceOf(beneficiary.address)).to.equal(ethers.parseEther("7"));
    const mbAttacker = await ethers.getContractAt("MintBurnAuthorityFacet", d.diamondAddr, beneficiary);
    await expect(mbAttacker.mintFloat(beneficiary.address, 1))
      .to.be.revertedWith("LibSettlement: not admin");
  });

  it("burnFloat decreases ERC20 balance", async () => {
    const d = await deployFullDiamond();
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const [_, __, who] = await ethers.getSigners();
    await mb.mintFloat(who.address, 100);
    await mb.burnFloat(who.address, 40);
    expect(await d.gsdcToken.balanceOf(who.address)).to.equal(60);
  });
});
