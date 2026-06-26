"use strict";
/**
 * Deploy PeaqToken to peaq network via Hardhat.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network agung
 *   npx hardhat run scripts/deploy.js --network peaq
 *   npx hardhat run scripts/deploy.js --network krest
 *
 * Required env vars:
 *   PRIVATE_KEY  — deployer private key (0x-prefixed)
 *
 * Optional env vars:
 *   TOKEN_NAME        — default: "peaq Token"
 *   TOKEN_SYMBOL      — default: "PEAQ"
 *   TOKEN_DECIMALS    — default: 18
 *   TOKEN_MAX_SUPPLY  — default: 0 (unlimited). Set to units (not wei).
 *   TOKEN_INITIAL_MINT — default: 1000000 (1M tokens)
 */

const { ethers } = require("hardhat");

async function main() {
  // ── Config from env ──────────────────────────────────────────────────────────
  const name        = process.env.TOKEN_NAME         || "peaq Token";
  const symbol      = process.env.TOKEN_SYMBOL       || "PEAQ";
  const decimals    = parseInt(process.env.TOKEN_DECIMALS    || "18", 10);
  const maxSupplyUI = parseFloat(process.env.TOKEN_MAX_SUPPLY   || "0");
  const initialUI   = parseFloat(process.env.TOKEN_INITIAL_MINT || "1000000");

  const maxSupply   = ethers.parseUnits(String(maxSupplyUI), decimals);
  const initialMint = ethers.parseUnits(String(initialUI),   decimals);

  // ── Deployer ─────────────────────────────────────────────────────────────────
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — set PRIVATE_KEY in .env");

  const network  = await ethers.provider.getNetwork();
  const balance  = await ethers.provider.getBalance(deployer.address);

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  PEAQ FORGE — PeaqToken Deployment");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Network:       ${network.name} (chainId: ${network.chainId})`);
  console.log(`  Deployer:      ${deployer.address}`);
  console.log(`  Balance:       ${ethers.formatEther(balance)} PEAQ`);
  console.log(`  Token Name:    ${name}`);
  console.log(`  Symbol:        ${symbol}`);
  console.log(`  Decimals:      ${decimals}`);
  console.log(`  Max Supply:    ${maxSupplyUI > 0 ? maxSupplyUI.toLocaleString() : "Unlimited"}`);
  console.log(`  Initial Mint:  ${initialUI.toLocaleString()} ${symbol}`);
  console.log("═══════════════════════════════════════════════════\n");

  if (balance === 0n) {
    throw new Error(`Deployer has 0 balance. Fund ${deployer.address} on ${network.name} first.`);
  }

  // ── Deploy ────────────────────────────────────────────────────────────────────
  console.log("Deploying PeaqToken...");
  const PeaqToken = await ethers.getContractFactory("PeaqToken");
  const token = await PeaqToken.deploy(name, symbol, decimals, maxSupply, initialMint);

  console.log(`Waiting for deployment transaction: ${token.deploymentTransaction()?.hash}`);
  await token.waitForDeployment();

  const address = await token.getAddress();
  const totalSupply = await token.totalSupply();

  console.log("\n✓ PeaqToken deployed successfully!");
  console.log(`  Contract address:  ${address}`);
  console.log(`  Total supply:      ${ethers.formatUnits(totalSupply, decimals)} ${symbol}`);
  console.log(`  Owner:             ${deployer.address}`);

  // ── Explorer links ────────────────────────────────────────────────────────────
  const explorers = {
    3338n: `https://peaq.subscan.io/account/${address}`,
    9990n: `https://agung.subscan.io/account/${address}`,
    2241n: `https://krest.subscan.io/account/${address}`,
  };
  const explorerUrl = explorers[network.chainId];
  if (explorerUrl) console.log(`  Explorer:          ${explorerUrl}`);

  console.log("\nDeployment complete.\n");
  return address;
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("\n✗ Deployment failed:", err.message);
    process.exit(1);
  });
