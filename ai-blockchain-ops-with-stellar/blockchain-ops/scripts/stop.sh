#!/usr/bin/env bash
# ============================================================
# STOP — AI Blockchain Ops
# Usage: ./scripts/stop.sh [--force] [--module <name>]
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$ROOT_DIR/.pids"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

FORCE=false
SINGLE_MODULE=""
TIMEOUT=15

while [[ $# -gt 0 ]]; do
  case $1 in
    --force)   FORCE=true; shift ;;
    --module)  SINGLE_MODULE="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: ./scripts/stop.sh [options]"
      echo ""
      echo "Options:"
      echo "  --force              Kill immediately (SIGKILL) instead of graceful SIGTERM"
      echo "  --module <name>   Stop only one module by name"
      echo "  --timeout <sec>      Wait N seconds for graceful shutdown (default: 15)"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo ""
echo -e "${BOLD}${CYAN}Stopping AI Blockchain Ops...${RESET}"
echo ""

# ── Stop single module by name ────────────────────────────────
if [[ -n "$SINGLE_MODULE" ]]; then
  PIDS=$(pgrep -f "$SINGLE_MODULE.ts" 2>/dev/null || true)
  if [[ -z "$PIDS" ]]; then
    echo -e "${YELLOW}⚠️  No process found for module: $SINGLE_MODULE${RESET}"
    exit 0
  fi
  for pid in $PIDS; do
    if $FORCE; then
      kill -9 "$pid" 2>/dev/null && echo -e "${GREEN}✅ Force killed $SINGLE_MODULE (PID $pid)${RESET}" || true
    else
      kill -TERM "$pid" 2>/dev/null && echo -e "${GREEN}✅ Stopped $SINGLE_MODULE (PID $pid)${RESET}" || true
    fi
  done
  exit 0
fi

# ── Stop main process from PID file ──────────────────────────
if [[ -f "$PID_FILE" ]]; then
  MAIN_PID=$(cat "$PID_FILE")
  if kill -0 "$MAIN_PID" 2>/dev/null; then
    echo -e "   Stopping main process (PID: $MAIN_PID)..."
    if $FORCE; then
      kill -9 "$MAIN_PID" 2>/dev/null || true
      echo -e "${GREEN}✅ Force killed (PID $MAIN_PID)${RESET}"
    else
      kill -TERM "$MAIN_PID" 2>/dev/null || true
      # Wait for graceful exit
      for i in $(seq 1 $TIMEOUT); do
        if ! kill -0 "$MAIN_PID" 2>/dev/null; then
          echo -e "${GREEN}✅ Gracefully stopped (PID $MAIN_PID) in ${i}s${RESET}"
          break
        fi
        sleep 1
        if [[ $i -eq $TIMEOUT ]]; then
          echo -e "${YELLOW}⚠️  Timeout — force killing...${RESET}"
          kill -9 "$MAIN_PID" 2>/dev/null || true
        fi
      done
    fi
  else
    echo -e "${YELLOW}⚠️  PID $MAIN_PID not running (stale PID file)${RESET}"
  fi
  rm -f "$PID_FILE"
fi

# ── Kill any remaining module processes ───────────────────────
MODULES=(
  "module1-relevance-gate"
  "module2-auditor"
  "module3-orchestrator"
  "module4-gateway"
  "module5-mcp"
  "module6-database"
  "module7-auth"
  "module8-secrets"
  "module9-events"
  "module10-admin"
  "module11-blockchain"
  "module12-frontend"
)

KILLED=0
for mod in "${MODULES[@]}"; do
  PIDS=$(pgrep -f "${mod}.ts" 2>/dev/null || true)
  if [[ -n "$PIDS" ]]; then
    for pid in $PIDS; do
      if $FORCE; then
        kill -9 "$pid" 2>/dev/null || true
      else
        kill -TERM "$pid" 2>/dev/null || true
      fi
      echo -e "   ${GREEN}Stopped ${mod} (PID $pid)${RESET}"
      KILLED=$((KILLED + 1))
    done
  fi
done

# ── Kill any tsx processes running our modules ─────────────────
TSX_PIDS=$(pgrep -f "tsx.*module[0-9]" 2>/dev/null || true)
if [[ -n "$TSX_PIDS" ]]; then
  for pid in $TSX_PIDS; do
    kill -9 "$pid" 2>/dev/null || true
    KILLED=$((KILLED + 1))
  done
fi

echo ""
if [[ $KILLED -gt 0 ]]; then
  echo -e "${GREEN}${BOLD}✅ System stopped ($KILLED processes terminated)${RESET}"
else
  echo -e "${GREEN}${BOLD}✅ System already stopped${RESET}"
fi
echo ""
