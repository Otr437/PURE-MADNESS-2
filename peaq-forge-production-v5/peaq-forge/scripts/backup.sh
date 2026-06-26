#!/usr/bin/env bash
# PEAQ FORGE v1 — Backup deploy log and config
# Usage: bash scripts/backup.sh [output_dir]

set -e

DEST="${1:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${DEST}/peaq_forge_backup_${TIMESTAMP}"

mkdir -p "$BACKUP_DIR"

echo "=== PEAQ FORGE v1 — Backup ==="
echo "Destination: $BACKUP_DIR"
echo ""

# Deploy log
DEPLOY_LOG="${PEAQ_FORGE_LOG_FILE:-$HOME/.peaq_forge_deployments.json}"
if [ -f "$DEPLOY_LOG" ]; then
  cp "$DEPLOY_LOG" "$BACKUP_DIR/deployments.json"
  echo "✓ Deploy log backed up ($(wc -c < "$DEPLOY_LOG") bytes)"
else
  echo "  No deploy log found at $DEPLOY_LOG"
fi

# .env (if exists)
if [ -f ".env" ]; then
  cp ".env" "$BACKUP_DIR/.env"
  echo "✓ .env backed up"
fi

# Logs directory
if [ -d "./logs" ]; then
  cp -r ./logs "$BACKUP_DIR/logs"
  echo "✓ Logs backed up"
fi

echo ""
echo "Backup complete: $BACKUP_DIR"
echo "Contents:"
ls -lh "$BACKUP_DIR"
