"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MultiSigWallet", function () {
  let multisig, owner, addr1, addr2, addr3, nonOwner;
  const REQUIRED = 2;

  beforeEach(async () => {
    [owner, addr1, addr2, addr3, nonOwner] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("MultiSigWallet");
    multisig = await Factory.deploy(
      [owner.address, addr1.address, addr2.address],
      REQUIRED
    );
    await multisig.waitForDeployment();
    // Fund the wallet with 1 PEAQ
    await owner.sendTransaction({ to: await multisig.getAddress(), value: ethers.parseEther("1") });
  });

  // ── Deployment ─────────────────────────────────────────────────────────
  describe("Deployment", () => {
    it("sets owners and required correctly", async () => {
      const owners = await multisig.getOwners();
      expect(owners).to.deep.equal([owner.address, addr1.address, addr2.address]);
      expect(await multisig.required()).to.equal(REQUIRED);
    });

    it("receives ETH/PEAQ correctly", async () => {
      expect(await multisig.getBalance()).to.be.gte(ethers.parseEther("1"));
    });

    it("reverts with zero owners", async () => {
      const Factory = await ethers.getContractFactory("MultiSigWallet");
      await expect(Factory.deploy([], 1)).to.be.revertedWithCustomError(multisig, "OwnersRequired");
    });

    it("reverts with required > owners", async () => {
      const Factory = await ethers.getContractFactory("MultiSigWallet");
      await expect(Factory.deploy([owner.address], 2))
        .to.be.revertedWithCustomError(multisig, "InvalidRequirement");
    });

    it("reverts with required = 0", async () => {
      const Factory = await ethers.getContractFactory("MultiSigWallet");
      await expect(Factory.deploy([owner.address], 0))
        .to.be.revertedWithCustomError(multisig, "InvalidRequirement");
    });
  });

  // ── Submit Transaction ──────────────────────────────────────────────────
  describe("submitTransaction", () => {
    it("owner can submit a transaction", async () => {
      const to    = addr3.address;
      const value = ethers.parseEther("0.1");
      await expect(multisig.connect(owner).submitTransaction(to, value, "0x", "Test tx"))
        .to.emit(multisig, "SubmitTransaction")
        .withArgs(owner.address, 0, to, value, "0x");
      expect(await multisig.getTransactionCount()).to.equal(1);
    });

    it("non-owner cannot submit", async () => {
      await expect(
        multisig.connect(nonOwner).submitTransaction(addr3.address, 0, "0x", "Bad tx")
      ).to.be.revertedWithCustomError(multisig, "NotOwner");
    });
  });

  // ── Confirm Transaction ────────────────────────────────────────────────
  describe("confirmTransaction", () => {
    beforeEach(async () => {
      await multisig.connect(owner).submitTransaction(addr3.address, ethers.parseEther("0.1"), "0x", "Pay addr3");
    });

    it("owner can confirm", async () => {
      await expect(multisig.connect(owner).confirmTransaction(0))
        .to.emit(multisig, "ConfirmTransaction")
        .withArgs(owner.address, 0);
      const [,,, , numConfs] = await multisig.getTransaction(0);
      expect(numConfs).to.equal(1);
    });

    it("cannot confirm twice", async () => {
      await multisig.connect(owner).confirmTransaction(0);
      await expect(multisig.connect(owner).confirmTransaction(0))
        .to.be.revertedWithCustomError(multisig, "TxAlreadyConfirmed");
    });

    it("non-owner cannot confirm", async () => {
      await expect(multisig.connect(nonOwner).confirmTransaction(0))
        .to.be.revertedWithCustomError(multisig, "NotOwner");
    });
  });

  // ── Execute Transaction ────────────────────────────────────────────────
  describe("executeTransaction", () => {
    let recipientBalBefore;

    beforeEach(async () => {
      recipientBalBefore = await ethers.provider.getBalance(addr3.address);
      await multisig.connect(owner).submitTransaction(
        addr3.address, ethers.parseEther("0.1"), "0x", "Pay addr3"
      );
    });

    it("executes after reaching threshold", async () => {
      await multisig.connect(owner).confirmTransaction(0);
      await multisig.connect(addr1).confirmTransaction(0);
      await expect(multisig.connect(owner).executeTransaction(0))
        .to.emit(multisig, "ExecuteTransaction")
        .withArgs(owner.address, 0);
      const [,,, executed] = await multisig.getTransaction(0);
      expect(executed).to.be.true;
      const balAfter = await ethers.provider.getBalance(addr3.address);
      expect(balAfter - recipientBalBefore).to.equal(ethers.parseEther("0.1"));
    });

    it("reverts with insufficient confirmations", async () => {
      await multisig.connect(owner).confirmTransaction(0); // only 1, need 2
      await expect(multisig.connect(owner).executeTransaction(0))
        .to.be.revertedWithCustomError(multisig, "NotEnoughConfirmations");
    });

    it("reverts on double execution", async () => {
      await multisig.connect(owner).confirmTransaction(0);
      await multisig.connect(addr1).confirmTransaction(0);
      await multisig.connect(owner).executeTransaction(0);
      await expect(multisig.connect(owner).executeTransaction(0))
        .to.be.revertedWithCustomError(multisig, "TxAlreadyExecuted");
    });
  });

  // ── Revoke Confirmation ────────────────────────────────────────────────
  describe("revokeConfirmation", () => {
    beforeEach(async () => {
      await multisig.connect(owner).submitTransaction(addr3.address, 0, "0x", "Test");
      await multisig.connect(owner).confirmTransaction(0);
    });

    it("owner can revoke their confirmation", async () => {
      await expect(multisig.connect(owner).revokeConfirmation(0))
        .to.emit(multisig, "RevokeConfirmation")
        .withArgs(owner.address, 0);
      const [,,,, numConfs] = await multisig.getTransaction(0);
      expect(numConfs).to.equal(0);
    });

    it("cannot revoke without prior confirmation", async () => {
      await expect(multisig.connect(addr1).revokeConfirmation(0))
        .to.be.revertedWithCustomError(multisig, "TxNotConfirmed");
    });
  });

  // ── getPendingTransactions ─────────────────────────────────────────────
  describe("getPendingTransactions", () => {
    it("returns only pending transactions", async () => {
      await multisig.connect(owner).submitTransaction(addr3.address, 0, "0x", "tx0");
      await multisig.connect(owner).submitTransaction(addr3.address, 0, "0x", "tx1");
      // execute tx0
      await multisig.connect(owner).confirmTransaction(0);
      await multisig.connect(addr1).confirmTransaction(0);
      await multisig.connect(owner).executeTransaction(0);

      const pending = await multisig.getPendingTransactions();
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(1n);
    });
  });
});
