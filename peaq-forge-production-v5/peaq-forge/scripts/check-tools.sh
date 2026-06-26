#!/usr/bin/env bash
echo "=== PEAQ FORGE v1 — Tool Check ==="
echo ""
check() {
  if command -v "$1" &>/dev/null; then
    echo "✓ $1: $($1 --version 2>&1 | head -1)"
  else
    echo "✗ $1: not found"
  fi
}
echo "--- Runtime ---"
check node
check npm
echo ""
echo "--- EVM / Foundry ---"
check forge
check cast
check anvil
echo ""
echo "--- Rust / ink! ---"
check cargo
cargo contract --version 2>/dev/null && echo "✓ cargo-contract installed" || echo "✗ cargo-contract: run 'cargo install cargo-contract'"
echo ""
echo "--- peaq SDK ---"
node -e "require('@peaq-network/sdk'); console.log('✓ @peaq-network/sdk installed')" 2>/dev/null || echo "✗ @peaq-network/sdk: run npm install"
echo ""
echo "--- Node.js version check ---"
NODE_VERSION=$(node --version | sed 's/v//')
MAJOR=$(echo $NODE_VERSION | cut -d. -f1)
if [ "$MAJOR" -ge 24 ]; then
  echo "✓ Node.js $NODE_VERSION — meets requirement (>=24)"
else
  echo "✗ Node.js $NODE_VERSION — UPGRADE REQUIRED. Use Node.js 24 LTS (Active LTS as of March 2026)"
fi
