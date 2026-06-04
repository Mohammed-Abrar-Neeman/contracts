import { expect } from "chai";
import { ethers } from "hardhat";

describe("EIP3009 — transferWithAuthorization on GSDCToken", () => {
  async function fixture() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const T = await ethers.getContractFactory("GSDCToken");
    const t = await T.deploy(deployer.address);
    await t.waitForDeployment();
    await (await t.mint(alice.address, ethers.parseEther("1000"))).wait();
    return { token: t, deployer, alice, bob };
  }

  async function signAuth(
    token: any, signer: any,
    from: string, to: string, value: bigint,
    validAfter: bigint, validBefore: bigint, nonce: string
  ) {
    const domain = {
      name: "GSDC", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await token.getAddress(),
    };
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    };
    const sig = await signer.signTypedData(domain, types, {
      from, to, value, validAfter, validBefore, nonce,
    });
    return ethers.Signature.from(sig);
  }

  it("happy path: signed authorization executes and emits AuthorizationUsed", async () => {
    const { token, alice, bob } = await fixture();
    const value = ethers.parseEther("100");
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("auth-1"));
    const validAfter = 0n;
    const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const validBefore = chainNow + 3600n;
    const sig = await signAuth(token, alice, alice.address, bob.address, value, validAfter, validBefore, nonce);

    await expect(token.transferWithAuthorization(
      alice.address, bob.address, value, validAfter, validBefore, nonce, sig.v, sig.r, sig.s,
    )).to.emit(token, "AuthorizationUsed").withArgs(alice.address, nonce);

    expect(await token.balanceOf(bob.address)).to.equal(value);
    expect(await token.authorizationState(alice.address, nonce)).to.equal(true);
  });

  it("replay rejected with AuthorizationAlreadyUsed", async () => {
    const { token, alice, bob } = await fixture();
    const value = ethers.parseEther("10");
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("auth-replay"));
    const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const validBefore = chainNow + 3600n;
    const sig = await signAuth(token, alice, alice.address, bob.address, value, 0n, validBefore, nonce);

    await token.transferWithAuthorization(alice.address, bob.address, value, 0, validBefore, nonce, sig.v, sig.r, sig.s);
    await expect(token.transferWithAuthorization(
      alice.address, bob.address, value, 0, validBefore, nonce, sig.v, sig.r, sig.s,
    )).to.be.revertedWithCustomError(token, "AuthorizationAlreadyUsed");
  });

  it("expired window rejected with AuthorizationExpired", async () => {
    const { token, alice, bob } = await fixture();
    const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const validBefore = chainNow - 1n; // already expired
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("auth-expired"));
    const sig = await signAuth(token, alice, alice.address, bob.address, 1n, 0n, validBefore, nonce);
    await expect(token.transferWithAuthorization(
      alice.address, bob.address, 1, 0, validBefore, nonce, sig.v, sig.r, sig.s,
    )).to.be.revertedWithCustomError(token, "AuthorizationExpired");
  });

  it("not-yet-valid rejected with AuthorizationNotYetValid", async () => {
    const { token, alice, bob } = await fixture();
    const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const validAfter = chainNow + 7200n;
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("auth-future"));
    const sig = await signAuth(token, alice, alice.address, bob.address, 1n, validAfter, validAfter + 100n, nonce);
    await expect(token.transferWithAuthorization(
      alice.address, bob.address, 1, validAfter, validAfter + 100n, nonce, sig.v, sig.r, sig.s,
    )).to.be.revertedWithCustomError(token, "AuthorizationNotYetValid");
  });

  it("wrong signer rejected with SignerMismatch", async () => {
    const { token, alice, bob, deployer } = await fixture();
    const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const validBefore = chainNow + 3600n;
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("auth-wrongsig"));
    // bob signs but `from` says alice — recovered != alice → revert.
    const sig = await signAuth(token, bob, alice.address, deployer.address, 1n, 0n, validBefore, nonce);
    await expect(token.transferWithAuthorization(
      alice.address, deployer.address, 1, 0, validBefore, nonce, sig.v, sig.r, sig.s,
    )).to.be.revertedWithCustomError(token, "SignerMismatch");
  });

  it("cancelAuthorization marks nonce used and prevents later transfer", async () => {
    const { token, alice, bob } = await fixture();
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("auth-cancel"));
    const domain = {
      name: "GSDC", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await token.getAddress(),
    };
    const types = {
      CancelAuthorization: [
        { name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" },
      ],
    };
    const cancelSig = ethers.Signature.from(
      await alice.signTypedData(domain, types, { authorizer: alice.address, nonce }),
    );
    await expect(token.cancelAuthorization(alice.address, nonce, cancelSig.v, cancelSig.r, cancelSig.s))
      .to.emit(token, "AuthorizationCanceled").withArgs(alice.address, nonce);
    expect(await token.authorizationState(alice.address, nonce)).to.equal(true);
    // Subsequent transfer with the same nonce reverts.
    const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const validBefore = chainNow + 3600n;
    const transferSig = ethers.Signature.from(await alice.signTypedData(domain, {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    }, { from: alice.address, to: bob.address, value: 1n, validAfter: 0n, validBefore, nonce }));
    await expect(token.transferWithAuthorization(
      alice.address, bob.address, 1, 0, validBefore, nonce, transferSig.v, transferSig.r, transferSig.s,
    )).to.be.revertedWithCustomError(token, "AuthorizationAlreadyUsed");
  });
});
