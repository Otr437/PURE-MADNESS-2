#!/usr/bin/env bash
set -e
echo "=== PEAQ FORGE v1 — Install Dev Tools ==="
echo ""
echo "--- Installing Foundry (forge, cast, anvil) ---"
curl -L https://foundry.paradigm.xyz | bash
source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null || true
foundryup
echo ""
echo "--- Installing cargo-contract (for ink!) ---"
cargo install cargo-contract --force
rustup target add wasm32-unknown-unknown
echo ""
echo "--- Installing npm dependencies ---"
npm install
echo ""
echo "--- Done. Run: npm start ---"
