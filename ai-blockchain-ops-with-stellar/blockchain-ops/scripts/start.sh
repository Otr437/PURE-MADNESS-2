#!/usr/bin/env bash
# ============================================================
# START — AI Blockchain Ops
# Usage: ./scripts/start.sh [--dev] [--module <name>] [--help]
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$ROOT_DIR/.pids"

# ── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Args ──────────────────────────────────────────────────────
DEV_MODE=false
SINGLE_MODULE=""
FOREGROUND=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --dev)        DEV_MODE=true; shift ;;
    --foreground) FOREGROUND=true; shift ;;
    --module)     SINGLE_MODULE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: ./scripts/start.sh [options]"
      echo ""
      echo "Options:"
      echo "  --dev              Start in development mode (tsx watch)"
      echo "  --foreground       Run main.ts in foreground (no background)"
      echo "  --module <name>    Start only one module (e.g. module11-blockchain)"
      echo "  --help             Show this help"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Header ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║         AI Blockchain Ops — Starting System          ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""

# ── Check working directory ───────────────────────────────────
cd "$ROOT_DIR"

# ── Check .env ────────────────────────────────────────────────
if [[ ! -f ".env" ]]; then
  echo -e "${RED}❌ .env file not found${RESET}"
  echo -e "   Run: ${YELLOW}cp .env.example .env${RESET} then fill in your values"
  exit 1
fi

# ── Check node version ────────────────────────────────────────
NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [[ -z "$NODE_VERSION" ]] || [[ "$NODE_VERSION" -lt 22 ]]; then
  echo -e "${RED}❌ Node.js 22+ required. Current: $(node --version 2>/dev/null || echo 'not found')${RESET}"
  echo -e "   Install from: https://nodejs.org or use nvm: ${YELLOW}nvm install 22${RESET}"
  exit 1
fi
echo -e "${GREEN}✅ Node.js $(node --version)${RESET}"

# ── Check tsx ─────────────────────────────────────────────────
if ! npx tsx --version &>/dev/null; then
  echo -e "${YELLOW}⚠️  tsx not found — installing...${RESET}"
  npm install
fi
echo -e "${GREEN}✅ tsx available${RESET}"

# ── Check PostgreSQL ──────────────────────────────────────────
source .env 2>/dev/null || true
if [[ -n "${DATABASE_URL:-}" ]]; then
  DB_HOST=$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')
  DB_PORT=$(echo "$DATABASE_URL" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
  DB_PORT="${DB_PORT:-5432}"
  if ! nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then
    echo -e "${RED}❌ PostgreSQL not reachable at $DB_HOST:$DB_PORT${RESET}"
    echo -e "   Start PostgreSQL or check DATABASE_URL in .env"
    echo -e "   Quick start: ${YELLOW}docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=aiblockchain postgres:16${RESET}"
    exit 1
  fi
  echo -e "${GREEN}✅ PostgreSQL reachable at $DB_HOST:$DB_PORT${RESET}"
else
  echo -e "${YELLOW}⚠️  DATABASE_URL not set in .env${RESET}"
fi

# ── Check required env vars ───────────────────────────────────
MISSING_VARS=()
for var in INTERNAL_SERVICE_TOKEN SECRETS_MASTER_KEY DATABASE_URL ANTHROPIC_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    MISSING_VARS+=("$var")
  fi
done

if [[ ${#MISSING_VARS[@]} -gt 0 ]]; then
  echo -e "${RED}❌ Missing required environment variables:${RESET}"
  for v in "${MISSING_VARS[@]}"; do
    echo -e "   ${RED}• $v${RESET}"
  done
  echo -e "\n   See ${YELLOW}.env.example${RESET} for setup instructions"
  exit 1
fi
echo -e "${GREEN}✅ Required env vars present${RESET}"

# ── Warn about optional AI keys ───────────────────────────────
for var in DEEPSEEK_API_KEY GEMINI_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo -e "${YELLOW}⚠️  $var not set — some AI features will be degraded${RESET}"
  fi
done

# ── Check Foundry (optional) ──────────────────────────────────
if command -v forge &>/dev/null; then
  echo -e "${GREEN}✅ Foundry (forge/cast) available${RESET}"
else
  echo -e "${YELLOW}⚠️  Foundry not found — Solidity compilation will use Hardhat fallback${RESET}"
  echo -e "   Install: ${YELLOW}curl -L https://foundry.paradigm.xyz | bash && foundryup${RESET}"
fi

# ── Create log dir ────────────────────────────────────────────
mkdir -p "$LOG_DIR"

# ── Start single module if requested ─────────────────────────
if [[ -n "$SINGLE_MODULE" ]]; then
  MODULE_FILE="modules/${SINGLE_MODULE}.ts"
  if [[ ! -f "$MODULE_FILE" ]]; then
    echo -e "${RED}❌ Module file not found: $MODULE_FILE${RESET}"
    exit 1
  fi
  echo -e "\n${CYAN}Starting single module: ${BOLD}$SINGLE_MODULE${RESET}"
  if $DEV_MODE; then
    npx tsx watch "$MODULE_FILE"
  else
    npx tsx "$MODULE_FILE"
  fi
  exit 0
fi

# ── Start full system ─────────────────────────────────────────
echo ""
echo -e "${BOLD}Starting all 12 modules...${RESET}"
echo ""

if $FOREGROUND || $DEV_MODE; then
  # Foreground / dev mode — run main.ts directly
  if $DEV_MODE; then
    echo -e "${CYAN}Development mode — tsx watch enabled${RESET}"
    NODE_ENV=development npx tsx watch main.ts
  else
    NODE_ENV=production npx tsx main.ts
  fi
else
  # Background mode — start as daemon
  LOG_FILE="$LOG_DIR/system-$(date +%Y%m%d-%H%M%S).log"

  echo -e "${CYAN}Starting in background...${RESET}"
  echo -e "   Logs: ${YELLOW}$LOG_FILE${RESET}"
  echo -e "   PIDs: ${YELLOW}$PID_FILE${RESET}"

  NODE_ENV=production nohup npx tsx main.ts > "$LOG_FILE" 2>&1 &
  MAIN_PID=$!
  echo "$MAIN_PID" > "$PID_FILE"

  echo -e "\n${GREEN}${BOLD}✅ System started (PID: $MAIN_PID)${RESET}"
  echo ""
  echo -e "   ${BOLD}Dashboard:${RESET}  ${CYAN}http://localhost:3012${RESET}"
  echo -e "   ${BOLD}API Gateway:${RESET} ${CYAN}http://localhost:3004${RESET}"
  echo -e "   ${BOLD}Admin:${RESET}       ${CYAN}http://localhost:3010${RESET}"
  echo ""
  echo -e "   View logs:  ${YELLOW}tail -f $LOG_FILE${RESET}"
  echo -e "   Stop:       ${YELLOW}./scripts/stop.sh${RESET}"
  echo -e "   Status:     ${YELLOW}./scripts/test.sh --health${RESET}"
  echo ""

  # Wait briefly and verify process is still running
  sleep 3
  if ! kill -0 "$MAIN_PID" 2>/dev/null; then
    echo -e "${RED}❌ Process died immediately — check logs:${RESET}"
    echo -e "   ${YELLOW}tail -50 $LOG_FILE${RESET}"
    exit 1
  fi
  echo -e "${GREEN}✅ Process confirmed running${RESET}"
fi
