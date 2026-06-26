#!/usr/bin/env bash
set -e

echo "=== PEAQ FORGE v1 — PM2 Setup ==="
echo ""

# Check pm2 is available
if ! command -v pm2 &>/dev/null; then
  echo "Installing PM2 globally..."
  npm install -g pm2
fi

PM2_VERSION=$(pm2 --version 2>/dev/null || echo "unknown")
echo "✓ PM2 version: $PM2_VERSION"
echo ""

# Ensure logs directory exists
mkdir -p ./logs

echo "Starting PEAQ FORGE with PM2..."
pm2 start ecosystem.config.js --env production

echo ""
echo "Setting up PM2 startup on reboot..."
pm2 save

echo ""
echo "✓ PM2 setup complete. Commands:"
echo "  npm run pm2:status   — view process status"
echo "  npm run pm2:logs     — tail logs"
echo "  npm run pm2:restart  — restart"
echo "  npm run pm2:stop     — stop"
echo ""
echo "To auto-start on system reboot, run:"
echo "  pm2 startup"
echo "  (then copy and run the command it prints)"
