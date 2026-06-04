import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFullDiamond } from "./helpers";

describe("MarginWallet", () => {
  async function setup() {
    const d = await deployFullDiamond();
    return d;
  }

  it("Diamond is the only allowed depositor", async () => {
    const d = await setup();
    const [_, __, randomCaller] = await ethers.getSigners();
    const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr, randomCaller);
    await expect(mw.deposit(1, ethers.id("settlement-1")))
      .to.be.revertedWithCustomError(mw, "NotSettlementDiamond");
  });

  it("owner can withdraw accumulated GSDC", async () => {
    const d = await setup();
    const [admin] = await ethers.getSigners();
    // Mint to the margin wallet so it has a balance to withdraw.
    const mb = await ethers.getContractAt("MintBurnAuthorityFacet", d.diamondAddr);
    await mb.mintFloat(d.tgsMarginAddr, ethers.parseEther("100"));
    const before = await d.gsdcToken.balanceOf(admin.address);
    const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr);
    await expect(mw.withdraw(admin.address, ethers.parseEther("40")))
      .to.emit(mw, "MarginWithdrawn").withArgs(admin.address, ethers.parseEther("40"));
    const after = await d.gsdcToken.balanceOf(admin.address);
    expect(after - before).to.equal(ethers.parseEther("40"));
  });

  it("non-owner cannot withdraw", async () => {
    const d = await setup();
    const [_, __, attacker] = await ethers.getSigners();
    const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr, attacker);
    await expect(mw.withdraw(attacker.address, 1)).to.be.revertedWithCustomError(mw, "NotOwner");
  });

  it("withdraw above balance reverts InsufficientBalance", async () => {
    const d = await setup();
    const [admin] = await ethers.getSigners();
    const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr);
    await expect(mw.withdraw(admin.address, ethers.parseEther("999999")))
      .to.be.revertedWithCustomError(mw, "InsufficientBalance");
  });

  it("constructor rejects zero addresses", async () => {
    const MW = await ethers.getContractFactory("MarginWallet");
    const [admin] = await ethers.getSigners();
    await expect(MW.deploy(ethers.ZeroAddress, admin.address, admin.address))
      .to.be.revertedWithCustomError(MW, "ZeroAddress");
  });

  it("balance() returns the GSDC token balance of the wallet", async () => {
    const d = await setup();
    const mb = await ethers.getContractAt("MintBurnAuthorityFacet", d.diamondAddr);
    await mb.mintFloat(d.tgsMarginAddr, 12345n);
    const mw = await ethers.getContractAt("MarginWallet", d.tgsMarginAddr);
    expect(await mw.balance()).to.equal(12345n);
  });
});
