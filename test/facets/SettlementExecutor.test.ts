import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFullDiamond, asFacet } from "../helpers";

const CORRIDOR_ID = ethers.id("INR_CNH");

describe("SettlementExecutorFacet", () => {
  it("rejects when corridor is not active", async () => {
    const d = await deployFullDiamond();
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    const [_, __, src, dst] = await ethers.getSigners();
    await expect(exec.executeSettlement(
      ethers.id("s1"), ethers.id("q1"), CORRIDOR_ID,
      src.address, dst.address, 1000, "0x", "0x", "0x",
    )).to.be.revertedWithCustomError(exec, "CorridorNotActive");
  });

  it("non-orchestrator cannot execute", async () => {
    const d = await deployFullDiamond();
    const [_, __, attacker] = await ethers.getSigners();
    const exec = await ethers.getContractAt("SettlementExecutorFacet", d.diamondAddr, attacker);
    await expect(exec.executeSettlement(
      ethers.id("s1"), ethers.id("q1"), CORRIDOR_ID,
      attacker.address, attacker.address, 1, "0x", "0x", "0x",
    )).to.be.revertedWith("LibSettlement: not orchestrator");
  });

  // [B-14 C6] recoverFailedSettlement test REMOVED — function deleted.

  it("getSettlement returns zeroed Settlement for unknown id", async () => {
    const d = await deployFullDiamond();
    const exec = await asFacet<any>(d.diamondAddr, "SettlementExecutorFacet");
    const s = await exec.getSettlement(ethers.id("none"));
    expect(s.status).to.equal(0);
  });
});
