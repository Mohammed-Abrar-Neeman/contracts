import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFullDiamond, asFacet } from "../helpers";

describe("FloatManagerFacet + LibFloat", () => {
  it("returns balance + zero reservation initially", async () => {
    const d = await deployFullDiamond();
    const fm = await asFacet<any>(d.diamondAddr, "FloatManagerFacet");
    const [_, __, partner] = await ethers.getSigners();
    // mint some GSDC to partner via Diamond's MintBurnAuthorityFacet.
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    await mb.mintFloat(partner.address, ethers.parseEther("500"));
    const [available, reserved] = await fm.getAvailableFloat(partner.address);
    expect(available).to.equal(ethers.parseEther("500"));
    expect(reserved).to.equal(0n);
  });

  it("reserveFloat reduces available + records per-settlement reservation", async () => {
    const d = await deployFullDiamond();
    const fm = await asFacet<any>(d.diamondAddr, "FloatManagerFacet");
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const [_, __, partner] = await ethers.getSigners();
    await mb.mintFloat(partner.address, ethers.parseEther("1000"));
    const sid = ethers.id("settlement-1");
    await expect(fm.reserveFloat(partner.address, sid, ethers.parseEther("400")))
      .to.emit(fm, "FloatReserved").withArgs(partner.address, sid, ethers.parseEther("400"));
    const [avail, res] = await fm.getAvailableFloat(partner.address);
    expect(avail).to.equal(ethers.parseEther("600"));
    expect(res).to.equal(ethers.parseEther("400"));
    expect(await fm.getSettlementReservation(sid)).to.equal(ethers.parseEther("400"));
  });

  it("rejects reservation when float insufficient", async () => {
    const d = await deployFullDiamond();
    const fm = await asFacet<any>(d.diamondAddr, "FloatManagerFacet");
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const [_, __, partner] = await ethers.getSigners();
    await mb.mintFloat(partner.address, ethers.parseEther("100"));
    const sid = ethers.id("settlement-2");
    await expect(fm.reserveFloat(partner.address, sid, ethers.parseEther("500")))
      .to.be.revertedWithCustomError(fm, "InsufficientFloat");
  });

  it("releaseFloatReservation restores availability", async () => {
    const d = await deployFullDiamond();
    const fm = await asFacet<any>(d.diamondAddr, "FloatManagerFacet");
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const [_, __, partner] = await ethers.getSigners();
    await mb.mintFloat(partner.address, ethers.parseEther("100"));
    const sid = ethers.id("settlement-3");
    await fm.reserveFloat(partner.address, sid, ethers.parseEther("50"));
    await expect(fm.releaseFloatReservation(partner.address, sid))
      .to.emit(fm, "FloatReleased").withArgs(partner.address, sid, ethers.parseEther("50"));
    expect(await fm.getSettlementReservation(sid)).to.equal(0n);
  });

  it("double-reservation on same settlementId rejected", async () => {
    const d = await deployFullDiamond();
    const fm = await asFacet<any>(d.diamondAddr, "FloatManagerFacet");
    const mb = await asFacet<any>(d.diamondAddr, "MintBurnAuthorityFacet");
    const [_, __, partner] = await ethers.getSigners();
    await mb.mintFloat(partner.address, ethers.parseEther("1000"));
    const sid = ethers.id("settlement-dup");
    await fm.reserveFloat(partner.address, sid, ethers.parseEther("100"));
    await expect(fm.reserveFloat(partner.address, sid, ethers.parseEther("100")))
      .to.be.revertedWithCustomError(fm, "ReservationAlreadyExists");
  });

  it("non-orchestrator cannot reserve", async () => {
    const d = await deployFullDiamond();
    const [_, __, partner] = await ethers.getSigners();
    const fm = await ethers.getContractAt("FloatManagerFacet", d.diamondAddr, partner);
    await expect(fm.reserveFloat(partner.address, ethers.id("s"), 1))
      .to.be.revertedWith("LibSettlement: not orchestrator");
  });
});
