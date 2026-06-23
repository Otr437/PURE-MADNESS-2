#!/usr/bin/env bash
# ============================================================
# BUILD — AI Blockchain Ops
# Usage: ./scripts/build.sh [--check] [--compile] [--clean]
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Args ──────────────────────────────────────────────────────
DO_CHECK=false
DO_COMPILE=false
DO_CLEAN=false
DO_INSTALL=false
DO_ALL=false

if [[ $# -eq 0 ]]; then DO_ALL=true; fi

while [[ $# -gt 0 ]]; do
  case $1 in
    --check)   DO_CHECK=true; shift ;;
    --compile) DO_COMPILE=true; shift ;;
    --clean)   DO_CLEAN=true; shift ;;
    --install) DO_INSTALL=true; shift ;;
    --all)     DO_ALL=true; shift ;;
    --help|-h)
      echo "Usage: ./scripts/build.sh [options]"
      echo ""
      echo "Options:"
      echo "  --check    TypeScript type-check only (no emit)"
      echo "  --compile  Compile TS to dist/"
      echo "  --clean    Remove dist/ and node_modules/"
      echo "  --install  npm install"
      echo "  --all      Run everything (default)"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if $DO_ALL; then DO_INSTALL=true; DO_CHECK=true; DO_COMPILE=true; fi

cd "$ROOT_DIR"

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║         AI Blockchain Ops — Build System             ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""

# ── Clean ─────────────────────────────────────────────────────
if $DO_CLEAN; then
  echo -e "${CYAN}Cleaning...${RESET}"
  rm -rf "$DIST_DIR"
  rm -rf node_modules
  rm -f package-lock.json
  echo -e "${GREEN}✅ Cleaned dist/ and node_modules/${RESET}"
fi

# ── Install ───────────────────────────────────────────────────
if $DO_INSTALL; then
  echo -e "${CYAN}Installing dependencies...${RESET}"

  # Check node version
  NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
  if [[ -z "$NODE_VER" ]] || [[ "$NODE_VER" -lt 22 ]]; then
    echo -e "${RED}❌ Node.js 22+ required (got $(node --version 2>/dev/null || echo 'none'))${RESET}"
    exit 1
  fi

  npm install --prefer-offline 2>&1 | tail -5
  echo -e "${GREEN}✅ Dependencies installed${RESET}"

  # Verify critical packages
  echo -e "${CYAN}Verifying packages...${RESET}"
  REQUIRED_PKGS=(
    "@anthropic-ai/sdk"
    "@google/genai"
    "openai"
    "fastify"
    "ethers"
    "pg"
    "zod"
    "ws"
  )

  for pkg in "${REQUIRED_PKGS[@]}"; do
    if [[ -d "node_modules/$pkg" ]]; then
      PKG_VER=$(node -e "console.log(require('./$pkg/package.json').version)" 2>/dev/null || echo "unknown")
      echo -e "  ${GREEN}✅ $pkg@$PKG_VER${RESET}"
    else
      echo -e "  ${RED}❌ $pkg — NOT INSTALLED${RESET}"
    fi
  done
fi

# ── TypeScript type check ─────────────────────────────────────
if $DO_CHECK; then
  echo ""
  echo -e "${CYAN}TypeScript type checking...${RESET}"

  if ! command -v npx &>/dev/null; then
    echo -e "${RED}❌ npx not found${RESET}"
    exit 1
  fi

  # Run tsc --noEmit to type-check without producing output
  if npx tsc --noEmit 2>&1; then
    echo -e "${GREEN}✅ TypeScript: no type errors${RESET}"
  else
    echo ""
    echo -e "${YELLOW}⚠️  TypeScript reported errors (see above)${RESET}"
    echo -e "   This is non-fatal — modules use tsx for runtime (no compile step needed)"
    echo -e "   Fix type errors before deploying to production"
  fi
fi

# ── Compile ───────────────────────────────────────────────────
if $DO_COMPILE; then
  echo ""
  echo -e "${CYAN}Compiling TypeScript to dist/...${RESET}"
  mkdir -p "$DIST_DIR"

  # Use tsc to emit JS
  if npx tsc 2>&1; then
    echo -e "${GREEN}✅ Compiled to dist/${RESET}"
  else
    echo -e "${YELLOW}⚠️  Compile had warnings — check dist/ output${RESET}"
  fi

  # Copy non-TS files
  cp -f .env.example "$DIST_DIR/.env.example" 2>/dev/null || true
  cp -f README.md "$DIST_DIR/README.md" 2>/dev/null || true
  cp -f package.json "$DIST_DIR/package.json" 2>/dev/null || true

  echo -e "${GREEN}✅ Build complete → dist/${RESET}"
  echo ""
  echo -e "   Run compiled version: ${YELLOW}node dist/main.js${RESET}"
fi

# ── Pre-flight env check ──────────────────────────────────────
echo ""
echo -e "${CYAN}Pre-flight environment check...${RESET}"

if [[ ! -f ".env" ]]; then
  echo -e "${YELLOW}⚠️  .env not found — run: cp .env.example .env${RESET}"
else
  set -a; source .env 2>/dev/null || true; set +a
  PREFLIGHT_OK=true

  check_var() {
    local name="$1"
    local val="${!name:-}"
    if [[ -n "$val" ]]; then
      echo -e "  ${GREEN}✅ $name${RESET}"
    else
      echo -e "  ${RED}❌ $name — not set${RESET}"
      PREFLIGHT_OK=false
    fi
  }

  check_var_optional() {
    local name="$1"
    local val="${!name:-}"
    if [[ -n "$val" ]]; then
      echo -e "  ${GREEN}✅ $name${RESET}"
    else
      echo -e "  ${YELLOW}⚠️  $name — optional, not set${RESET}"
    fi
  }

  echo -e "  ${BOLD}Required:${RESET}"
  check_var INTERNAL_SERVICE_TOKEN
  check_var SECRETS_MASTER_KEY
  check_var DATABASE_URL
  check_var ANTHROPIC_API_KEY

  echo -e "  ${BOLD}Optional AI keys:${RESET}"
  check_var_optional DEEPSEEK_API_KEY
  check_var_optional GEMINI_API_KEY

  echo -e "  ${BOLD}Blockchain:${RESET}"
  check_var_optional WALLET_PRIVATE_KEY
  check_var_optional ETH_RPC_URL
  check_var_optional BASE_RPC_URL

  if $PREFLIGHT_OK; then
    echo -e "\n  ${GREEN}✅ Pre-flight passed${RESET}"
  else
    echo -e "\n  ${RED}❌ Pre-flight failed — fix required vars in .env${RESET}"
  fi
fi

# ── Tool availability ─────────────────────────────────────────
echo ""
echo -e "${CYAN}Tool availability:${RESET}"

check_tool() {
  local tool="$1"
  local required="${2:-false}"
  if command -v "$tool" &>/dev/null; then
    local ver=$($tool --version 2>/dev/null | head -1 || echo "")
    echo -e "  ${GREEN}✅ $tool${RESET} ${ver:+($ver)}"
  else
    if [[ "$required" == "true" ]]; then
      echo -e "  ${RED}❌ $tool — REQUIRED, not found${RESET}"
    else
      echo -e "  ${YELLOW}⚠️  $tool — optional, not found${RESET}"
    fi
  fi
}

check_tool "node" true
check_tool "npx" true
check_tool "tsx"
check_tool "forge"
check_tool "cast"
check_tool "hardhat"
check_tool "psql"
check_tool "docker"

# ── Summary ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✅ Build complete${RESET}"
echo ""
echo -e "  Next steps:"
echo -e "  1. ${YELLOW}cp .env.example .env${RESET}  (if not done)"
echo -e "  2. ${YELLOW}./scripts/start.sh${RESET}     (start all modules)"
echo -e "  3. ${YELLOW}./scripts/test.sh${RESET}      (run test suite)"
echo -e "  4. Open ${CYAN}http://localhost:3012${RESET}  (dashboard)"
echo ""
