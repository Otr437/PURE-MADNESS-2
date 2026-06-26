"use strict";

const { expect }  = require("chai");
const { ethers }  = require("hardhat");

describe("PeaqToken", function () {
  let token, owner, addr1, addr2;

  const NAME         = "peaq Token";
  const SYMBOL       = "PEAQ";
  const DECIMALS     = 18;
  const MAX_SUPPLY   = ethers.parseUnits("100000000", 18); // 100M
  const INITIAL_MINT = ethers.parseUnits("1000000",   18); // 1M

  beforeEach(async () => {
    [owner, addr1, addr2] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("PeaqToken");
    token = await Factory.deploy(NAME, SYMBOL, DECIMALS, MAX_SUPPLY, INITIAL_MINT);
    await token.waitForDeployment();
  });

  // ── Deployment ────────────────────────────────────────────────────────────
  describe("Deployment", () => {
    it("sets correct name and symbol", async () => {
      expect(await token.name()).to.equal(NAME);
      expect(await token.symbol()).to.equal(SYMBOL);
    });

    it("sets correct decimals", async () => {
      expect(await token.decimals()).to.equal(DECIMALS);
    });

    it("mints initial supply to owner", async () => {
      expect(await token.balanceOf(owner.address)).to.equal(INITIAL_MINT);
      expect(await token.totalSupply()).to.equal(INITIAL_MINT);
    });

    it("sets correct max supply", async () => {
      expect(await token.MAX_SUPPLY()).to.equal(MAX_SUPPLY);
    });

    it("sets owner correctly", async () => {
      expect(await token.owner()).to.equal(owner.address);
    });
  });

  // ── Minting ───────────────────────────────────────────────────────────────
  describe("Minting", () => {
    it("allows owner to mint tokens", async () => {
      const amount = ethers.parseUnits("500000", 18);
      await token.connect(owner).mint(addr1.address, amount);
      expect(await token.balanceOf(addr1.address)).to.equal(amount);
    });

    it("reverts mint from non-owner", async () => {
      const amount = ethers.parseUnits("100", 18);
      await expect(token.connect(addr1).mint(addr1.address, amount))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("reverts mint that exceeds max supply", async () => {
      const tooMuch = MAX_SUPPLY; // already have INITIAL_MINT, so total would exceed MAX_SUPPLY
      await expect(token.connect(owner).mint(addr1.address, tooMuch))
        .to.be.revertedWithCustomError(token, "ExceedsMaxSupply");
    });

    it("allows minting up to exact max supply", async () => {
      const remaining = MAX_SUPPLY - INITIAL_MINT;
      await token.connect(owner).mint(addr1.address, remaining);
      expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
    });
  });

  // ── Transfers ─────────────────────────────────────────────────────────────
  describe("Transfers", () => {
    it("transfers tokens between accounts", async () => {
      const amount = ethers.parseUnits("100", 18);
      await token.connect(owner).transfer(addr1.address, amount);
      expect(await token.balanceOf(addr1.address)).to.equal(amount);
    });

    it("reverts transfer with insufficient balance", async () => {
      const amount = ethers.parseUnits("1", 18);
      await expect(token.connect(addr1).transfer(addr2.address, amount))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });
  });

  // ── Burning ───────────────────────────────────────────────────────────────
  describe("Burning", () => {
    it("allows token holder to burn tokens", async () => {
      const amount = ethers.parseUnits("100", 18);
      const before = await token.totalSupply();
      await token.connect(owner).burn(amount);
      expect(await token.totalSupply()).to.equal(before - amount);
    });

    it("reverts burn exceeding balance", async () => {
      const amount = ethers.parseUnits("1", 18);
      await expect(token.connect(addr1).burn(amount))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });
  });

  // ── Pause ─────────────────────────────────────────────────────────────────
  describe("Pause", () => {
    it("owner can pause and unpause", async () => {
      await token.connect(owner).pause();
      expect(await token.paused()).to.be.true;
      await token.connect(owner).unpause();
      expect(await token.paused()).to.be.false;
    });

    it("reverts transfer when paused", async () => {
      await token.connect(owner).pause();
      await expect(token.connect(owner).transfer(addr1.address, 1n))
        .to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("non-owner cannot pause", async () => {
      await expect(token.connect(addr1).pause())
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("allows transfer after unpause", async () => {
      const amount = ethers.parseUnits("10", 18);
      await token.connect(owner).pause();
      await token.connect(owner).unpause();
      await expect(token.connect(owner).transfer(addr1.address, amount)).to.not.be.reverted;
    });
  });

  // ── Ownership ─────────────────────────────────────────────────────────────
  describe("Ownership", () => {
    it("owner can transfer ownership", async () => {
      await token.connect(owner).transferOwnership(addr1.address);
      expect(await token.owner()).to.equal(addr1.address);
    });

    it("new owner can mint after transfer", async () => {
      await token.connect(owner).transferOwnership(addr1.address);
      const amount = ethers.parseUnits("100", 18);
      await token.connect(addr1).mint(addr2.address, amount);
      expect(await token.balanceOf(addr2.address)).to.equal(amount);
    });
  });
});
