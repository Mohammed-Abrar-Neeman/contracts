import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFullDiamond, asFacet } from "../helpers";

const CORRIDOR_ID = ethers.id("INR_CNH");

describe("ComplianceGateFacet", () => {
  it("registers a partner + exposes corridor authorisation", async () => {
    const d = await deployFullDiamond();
    const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
    const [_admin, _oracle, partner, mw] = await ethers.getSigners();
    const kyc = ethers.id("kyc-bharat-v1");

    await expect(cg.registerPartner(partner.address, partner.address, mw.address, kyc, [CORRIDOR_ID]))
      .to.emit(cg, "PartnerRegistered").withArgs(partner.address, kyc);
    expect(await cg.checkCompliance(partner.address, CORRIDOR_ID)).to.equal(true);
  });

  it("rejects double-register with PartnerAlreadyRegistered", async () => {
    const d = await deployFullDiamond();
    const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
    const [_, __, partner, mw] = await ethers.getSigners();
    const kyc = ethers.id("kyc");
    await cg.registerPartner(partner.address, partner.address, mw.address, kyc, []);
    await expect(cg.registerPartner(partner.address, partner.address, mw.address, kyc, []))
      .to.be.revertedWithCustomError(cg, "PartnerAlreadyRegistered");
  });

  it("suspendPartner blocks compliance check; reactivate restores", async () => {
    const d = await deployFullDiamond();
    const cg = await asFacet<any>(d.diamondAddr, "ComplianceGateFacet");
    const [_, __, partner, mw] = await ethers.getSigners();
    await cg.registerPartner(partner.address, partner.address, mw.address, ethers.id("k"), [CORRIDOR_ID]);
    await cg.suspendPartner(partner.address);
    await expect(cg.checkCompliance(partner.address, CORRIDOR_ID)).to.be.revertedWithCustomError(cg, "PartnerSuspended_");
    await cg.reactivatePartner(partner.address);
    expect(await cg.checkCompliance(partner.address, CORRIDOR_ID)).to.equal(true);
  });

  it("non-admin cannot register", async () => {
    const d = await deployFullDiamond();
    const [_, __, partner] = await ethers.getSigners();
    const cg = await ethers.getContractAt("ComplianceGateFacet", d.diamondAddr, partner);
    await expect(cg.registerPartner(partner.address, partner.address, partner.address, ethers.id("k"), []))
      .to.be.revertedWith("LibSettlement: not admin");
  });
});
