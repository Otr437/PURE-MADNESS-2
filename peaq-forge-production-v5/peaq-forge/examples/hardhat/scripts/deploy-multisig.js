"use strict";
/**
 * Deploy MultiSigWallet to peaq network via Hardhat.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-multisig.js --network agung
 *   npx hardhat run scripts/deploy-multisig.js --network peaq
 *
 * Required env vars:
 *   PRIVATE_KEY   — deployer private key (0x-prefixed)
 *
 * Optional env vars:
 *   MULTISIG_OWNERS    — comma-separated owner addresses.
 *                        Defaults to deployer only (1-of-1, useful for testing).
 *   MULTISIG_REQUIRED  — number of required confirmations. Defaults to majority.
 *
 * Example (3-of-5 multisig):
 *   MULTISIG_OWNERS=0xAAA,0xBBB,0xCCC,0xDDD,0xEEE MULTISIG_REQUIRED=3 \
 *     npx hardhat run scripts/deploy-multisig.js --network agung
 */

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — set PRIVATE_KEY in .env");

  // ── Parse owners ─────────────────────────────────────────────────────────────
  const rawOwners = process.env.MULTISIG_OWNERS;
  let owners;
  if (rawOwners) {
    owners = rawOwners.split(",").map(a => a.trim()).filter(Boolean);
    for (const addr of owners) {
      if (!ethers.isAddress(addr)) throw new Error(`Invalid owner address: ${addr}`);
    }
  } else {
    owners = [deployer.address];
  }

  const required = parseInt(process.env.MULTISIG_REQUIRED || String(Math.ceil(owners.length / 2)), 10);

  if (required < 1 || required > owners.length) {
    throw new Error(`MULTISIG_REQUIRED (${required}) must be between 1 and ${owners.length}`);
  }

  // ── Print deployment config ────────────────────────────────────────────────────
  const network = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  PEAQ FORGE — MultiSigWallet Deployment");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Network:     ${network.name} (chainId: ${network.chainId})`);
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  Balance:     ${ethers.formatEther(balance)} PEAQ`);
  console.log(`  Threshold:   ${required}-of-${owners.length}`);
  console.log(`  Owners:`);
  owners.forEach((o, i) => console.log(`    [${i + 1}] ${o}`));
  console.log("═══════════════════════════════════════════════════\n");

  if (balance === 0n) {
    throw new Error(`Deployer has 0 balance. Fund ${deployer.address} on ${network.name} first.`);
  }

  // ── Deploy ─────────────────────────────────────────────────────────────────────
  console.log("Deploying MultiSigWallet...");
  const MultiSig = await ethers.getContractFactory("MultiSigWallet");
  const multisig = await MultiSig.deploy(owners, required);

  console.log(`TX hash: ${multisig.deploymentTransaction()?.hash}`);
  await multisig.waitForDeployment();

  const address = await multisig.getAddress();

  console.log("\n✓ MultiSigWallet deployed successfully!");
  console.log(`  Contract address:  ${address}`);
  console.log(`  Threshold:         ${required}-of-${owners.length}`);

  const explorers = {
    3338n: `https://peaq.subscan.io/account/${address}`,
    9990n: `https://agung.subscan.io/account/${address}`,
    2241n: `https://krest.subscan.io/account/${address}`,
  };
  const explorerUrl = explorers[network.chainId];
  if (explorerUrl) console.log(`  Explorer:          ${explorerUrl}`);

  // ── Post-deploy summary ────────────────────────────────────────────────────────
  console.log("\n  To submit a transaction through the multisig:");
  console.log(`    cast send ${address} "submitTransaction(address,uint256,bytes,string)" \\`);
  console.log(`      <recipient> <value_wei> 0x "Description" \\`);
  console.log(`      --private-key $PRIVATE_KEY --rpc-url $RPC_URL`);
  console.log("\n  To confirm a transaction (txIndex = 0):");
  console.log(`    cast send ${address} "confirmTransaction(uint256)" 0 \\`);
  console.log(`      --private-key $PRIVATE_KEY --rpc-url $RPC_URL`);
  console.log("\n  To execute after threshold reached:");
  console.log(`    cast send ${address} "executeTransaction(uint256)" 0 \\`);
  console.log(`      --private-key $PRIVATE_KEY --rpc-url $RPC_URL\n`);

  return address;
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("\n✗ Deployment failed:", err.message);
    process.exit(1);
  });
