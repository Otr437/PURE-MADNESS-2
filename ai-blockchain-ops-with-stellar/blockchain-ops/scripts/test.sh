#!/usr/bin/env bash
# ============================================================
# TEST — AI Blockchain Ops
# Usage: ./scripts/test.sh [--health] [--auth] [--blockchain]
#                          [--ai] [--all] [--verbose]
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Args ──────────────────────────────────────────────────────
RUN_HEALTH=false
RUN_AUTH=false
RUN_BLOCKCHAIN=false
RUN_STELLAR=false
RUN_AI=false
RUN_ALL=false
VERBOSE=false

if [[ $# -eq 0 ]]; then RUN_ALL=true; fi

while [[ $# -gt 0 ]]; do
  case $1 in
    --health)     RUN_HEALTH=true; shift ;;
    --auth)       RUN_AUTH=true; shift ;;
    --blockchain) RUN_BLOCKCHAIN=true; shift ;;
    --stellar)    RUN_STELLAR=true; shift ;;
    --ai)         RUN_AI=true; shift ;;
    --all)        RUN_ALL=true; shift ;;
    --verbose|-v) VERBOSE=true; shift ;;
    --help|-h)
      echo "Usage: ./scripts/test.sh [options]"
      echo ""
      echo "Options:"
      echo "  --health      Test all module health endpoints"
      echo "  --auth        Test auth flow (register, login, token)"
      echo "  --blockchain  Test blockchain ops (gas, wallet, compile)"
      echo "  --ai          Test AI pipeline (gate, audit, orchestrator)"
      echo "  --all         Run all tests (default)"
      echo "  --verbose     Show full response bodies"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if $RUN_ALL; then RUN_HEALTH=true; RUN_AUTH=true; RUN_BLOCKCHAIN=true; RUN_STELLAR=true; RUN_AI=true; fi

# ── Load env ──────────────────────────────────────────────────
cd "$ROOT_DIR"
if [[ -f ".env" ]]; then
  set -a; source .env 2>/dev/null || true; set +a
fi

GATEWAY="http://localhost:3004"
BLOCKCHAIN="http://localhost:3011"
STELLAR="http://localhost:3015"
GATE="http://localhost:3001"
AUDITOR="http://localhost:3002"
AUTH_SVC="http://localhost:3007"
DB_SVC="http://localhost:3006"
EVENTS="http://localhost:3009"
SECRETS="http://localhost:3008"
ADMIN="http://localhost:3010"
MCP="http://localhost:3005"
INTERNAL_TOKEN="${INTERNAL_SERVICE_TOKEN:-}"

PASS=0
FAIL=0
SKIP=0

# ── Test helpers ──────────────────────────────────────────────
assert_status() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  local body="${4:-}"

  if [[ "$actual" == "$expected" ]]; then
    echo -e "  ${GREEN}✅ $desc${RESET}"
    PASS=$((PASS + 1))
    if $VERBOSE && [[ -n "$body" ]]; then
      echo -e "     ${BLUE}$body${RESET}" | head -5
    fi
  else
    echo -e "  ${RED}❌ $desc (expected $expected, got $actual)${RESET}"
    if [[ -n "$body" ]]; then
      echo -e "     ${RED}$body${RESET}" | head -5
    fi
    FAIL=$((FAIL + 1))
  fi
}

http_get() {
  local url="$1"
  local headers="${2:-}"
  if [[ -n "$headers" ]]; then
    curl -s -o /tmp/test_body -w "%{http_code}" $headers "$url" 2>/dev/null || echo "000"
  else
    curl -s -o /tmp/test_body -w "%{http_code}" "$url" 2>/dev/null || echo "000"
  fi
}

http_post() {
  local url="$1"
  local body="$2"
  local headers="${3:-}"
  curl -s -o /tmp/test_body -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    $headers \
    -d "$body" "$url" 2>/dev/null || echo "000"
}

get_body() { cat /tmp/test_body 2>/dev/null || echo ""; }
get_json_field() { get_body | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1',''))" 2>/dev/null || echo ""; }

internal_header() { echo "-H 'x-aiops-service-token: $INTERNAL_TOKEN'"; }

# ── HEALTH TESTS ──────────────────────────────────────────────
if $RUN_HEALTH; then
  echo ""
  echo -e "${BOLD}${CYAN}━━━ Health Checks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

  declare -A MODULE_PORTS=(
    ["module1-relevance-gate"]="3001"
    ["module2-auditor"]="3002"
    ["module3-orchestrator"]="3003"
    ["module4-gateway"]="3004"
    ["module5-mcp"]="3005"
    ["module6-database"]="3006"
    ["module7-auth"]="3007"
    ["module8-secrets"]="3008"
    ["module9-events"]="3009"
    ["module10-admin"]="3010"
    ["module11-blockchain"]="3011"
    ["module15-stellar"]="3015"
    ["module12-frontend"]="3012"
  )

  for mod in "${!MODULE_PORTS[@]}"; do
    port="${MODULE_PORTS[$mod]}"
    status=$(http_get "http://localhost:$port/health")
    body=$(get_body)
    assert_status "$mod (port $port)" "200" "$status" "$body"
  done
fi

# ── AUTH TESTS ────────────────────────────────────────────────
AUTH_TOKEN=""
if $RUN_AUTH; then
  echo ""
  echo -e "${BOLD}${CYAN}━━━ Auth Flow ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

  TEST_EMAIL="test-$(date +%s)@aiops.local"
  TEST_PASS="TestPassword123!"

  # Register
  status=$(http_post "$GATEWAY/auth/register" \
    "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASS\",\"role\":\"operator\"}")
  assert_status "POST /auth/register" "201" "$status" "$(get_body)"

  # Login
  status=$(http_post "$GATEWAY/auth/login" \
    "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASS\"}")
  assert_status "POST /auth/login" "200" "$status"
  AUTH_TOKEN=$(get_json_field "access_token")
  if [[ -n "$AUTH_TOKEN" ]]; then
    echo -e "  ${BLUE}ℹ️  Got access token: ${AUTH_TOKEN:0:20}...${RESET}"
  fi

  # Wrong password
  status=$(http_post "$GATEWAY/auth/login" \
    "{\"email\":\"$TEST_EMAIL\",\"password\":\"WrongPass123!\"}")
  assert_status "POST /auth/login (wrong pass → 401)" "401" "$status"

  # Introspect token (internal)
  if [[ -n "$AUTH_TOKEN" && -n "$INTERNAL_TOKEN" ]]; then
    status=$(http_post "$AUTH_SVC/introspect" \
      "{\"token\":\"$AUTH_TOKEN\"}" \
      "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "POST /introspect" "200" "$status"
    ACTIVE=$(get_json_field "active")
    if [[ "$ACTIVE" == "True" ]] || [[ "$ACTIVE" == "true" ]]; then
      echo -e "  ${GREEN}  Token is active ✅${RESET}"
    fi
  fi

  # Revoke token
  if [[ -n "$AUTH_TOKEN" ]]; then
    status=$(http_post "$GATEWAY/auth/revoke" "{\"token\":\"$AUTH_TOKEN\"}")
    assert_status "POST /auth/revoke" "200" "$status"
  fi

  # OAuth2 client_credentials (need to create client first)
  if [[ -n "$INTERNAL_TOKEN" ]]; then
    status=$(http_post "$AUTH_SVC/clients" \
      '{"name":"test-client","scopes":["tasks:read","blockchain:read"],"grantTypes":["client_credentials"]}' \
      "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "POST /clients (create OAuth client)" "201" "$status"
    CLIENT_ID=$(get_json_field "clientId")
    CLIENT_SECRET=$(get_json_field "clientSecret")

    if [[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]]; then
      status=$(http_post "$GATEWAY/auth/token" \
        "{\"grant_type\":\"client_credentials\",\"client_id\":\"$CLIENT_ID\",\"client_secret\":\"$CLIENT_SECRET\",\"scope\":\"tasks:read blockchain:read\"}")
      assert_status "POST /auth/token (client_credentials)" "200" "$status"
      CC_TOKEN=$(get_json_field "access_token")
      if [[ -n "$CC_TOKEN" ]]; then
        echo -e "  ${BLUE}ℹ️  Client credentials token: ${CC_TOKEN:0:20}...${RESET}"
        AUTH_TOKEN="$CC_TOKEN"
      fi
    fi
  fi
fi

# ── GATE + AUDITOR TESTS ──────────────────────────────────────
if $RUN_AI; then
  echo ""
  echo -e "${BOLD}${CYAN}━━━ Gate + Auditor Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

  if [[ -z "$INTERNAL_TOKEN" ]]; then
    echo -e "  ${YELLOW}⚠️  INTERNAL_SERVICE_TOKEN not set — skipping internal tests${RESET}"
    SKIP=$((SKIP + 3))
  else
    # Gate check — good content
    status=$(http_post "$GATE/check" \
      '{"content":"import Fastify from fastify","contentType":"code","submittedBy":"orchestrator"}' \
      "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "POST /check (good code)" "200" "$status"

    # Gate check — blocked package
    status=$(http_post "$GATE/check" \
      '{"content":"import express from @google/generative-ai","contentType":"code","submittedBy":"orchestrator"}' \
      "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "POST /check (blocked package → 422)" "422" "$status"

    # Solidity check — tx.origin vulnerability
    status=$(http_post "$GATE/check-solidity" \
      '{"source":"pragma solidity ^0.8.24;\ncontract Bad { function auth() public { require(tx.origin == owner); } }"}' \
      "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "POST /check-solidity (tx.origin → 422)" "422" "$status"

    # Gate circuit
    status=$(http_get "$GATE/circuit")
    assert_status "GET /circuit" "200" "$status"

    # Gate metrics
    status=$(http_get "$GATE/metrics")
    assert_status "GET /metrics (gate)" "200" "$status"

    # Auditor — audit simple code
    TASK_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
    status=$(http_post "$AUDITOR/audit" \
      "{\"content\":\"const x = 1 + 1;\",\"contentType\":\"output\",\"taskId\":\"$TASK_ID\"}" \
      "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "POST /audit" "200" "$status"

    # Auditor metrics
    status=$(http_get "$AUDITOR/metrics" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "GET /metrics (auditor)" "200" "$status"
  fi
fi

# ── BLOCKCHAIN TESTS ──────────────────────────────────────────
if $RUN_BLOCKCHAIN; then
  echo ""
  echo -e "${BOLD}${CYAN}━━━ Blockchain Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

  if [[ -z "$INTERNAL_TOKEN" ]]; then
    echo -e "  ${YELLOW}⚠️  INTERNAL_SERVICE_TOKEN not set — skipping${RESET}"
    SKIP=$((SKIP + 5))
  else
    # Chains
    status=$(http_get "$BLOCKCHAIN/chains" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "GET /chains" "200" "$status"

    # Gas — localhost (31337)
    status=$(http_get "$BLOCKCHAIN/gas?chainId=31337" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    # May be 200 or 502 depending on whether local node is running
    if [[ "$status" == "200" ]]; then
      assert_status "GET /gas?chainId=31337 (local node)" "200" "$status"
      GWEI=$(get_json_field "baseFeeGwei")
      echo -e "  ${BLUE}ℹ️  Base fee: ${GWEI} gwei${RESET}"
    else
      echo -e "  ${YELLOW}⚠️  GET /gas (local node not running — expected)${RESET}"
      SKIP=$((SKIP + 1))
    fi

    # Gas — Ethereum mainnet (requires ETH_RPC_URL)
    status=$(http_get "$BLOCKCHAIN/gas?chainId=1" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    if [[ "$status" == "200" ]]; then
      assert_status "GET /gas?chainId=1 (mainnet)" "200" "$status"
      GWEI=$(get_json_field "baseFeeGwei")
      echo -e "  ${BLUE}ℹ️  ETH mainnet base fee: ${GWEI} gwei${RESET}"
    else
      echo -e "  ${YELLOW}⚠️  GET /gas mainnet (RPC unreachable)${RESET}"
      SKIP=$((SKIP + 1))
    fi

    # Compile Solidity
    SOLIDITY='// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\ncontract Counter { uint256 public count; function increment() external { count++; } }'
    TASK_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
    status=$(http_post "$BLOCKCHAIN/compile" \
      "{\"taskId\":\"$TASK_ID\",\"contractName\":\"Counter\",\"source\":\"$SOLIDITY\"}" \
      "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    if [[ "$status" == "200" ]]; then
      assert_status "POST /compile (Solidity Counter)" "200" "$status"
      echo -e "  ${BLUE}ℹ️  Contract compiled successfully${RESET}"
    else
      echo -e "  ${YELLOW}⚠️  POST /compile (forge/hardhat may not be installed)${RESET}"
      SKIP=$((SKIP + 1))
    fi

    # Generate meme token source
    status=$(http_post "$BLOCKCHAIN/meme-token/generate-source" \
      '{"config":{"name":"Test Coin","symbol":"TEST","totalSupply":"1000000000","decimals":18,"mintable":false,"burnable":true,"taxBuyPercent":3,"taxSellPercent":5,"maxWalletPercent":2}}' \
      "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "POST /meme-token/generate-source" "200" "$status"
    if $VERBOSE; then
      echo -e "  ${BLUE}ℹ️  Generated $(get_body | wc -c) bytes of Solidity${RESET}"
    fi

    # Contracts list
    status=$(http_get "$BLOCKCHAIN/contracts" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "GET /contracts" "200" "$status"

    # Transactions list
    status=$(http_get "$BLOCKCHAIN/transactions" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "GET /transactions" "200" "$status"
  fi
fi

# ── STELLAR TESTS ─────────────────────────────────────────────
if $RUN_STELLAR; then
  echo ""
  echo -e "${BOLD}${CYAN}━━━ Stellar Engine Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

  # Health check
  status=$(http_get "$STELLAR/health")
  assert_status "GET /health" "200" "$status"

  # Networks list (public, no auth needed)
  status=$(http_get "$STELLAR/networks")
  assert_status "GET /networks" "200" "$status"

  # Fee stats (testnet)
  status=$(http_get "$STELLAR/fee-stats?network=testnet" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /fee-stats (testnet)" "200" "$status"

  # Latest ledger
  status=$(http_get "$STELLAR/ledger?network=testnet" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /ledger (testnet)" "200" "$status"

  # Keypair generation
  status=$(http_post "$STELLAR/keypair/generate" '{}' "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "POST /keypair/generate" "200" "$status"

  # Asset info — native XLM
  status=$(http_get "$STELLAR/asset/info?network=testnet&code=XLM" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /asset/info (XLM)" "200" "$status"

  # Sequence lock state
  status=$(http_get "$STELLAR/sequence" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /sequence" "200" "$status"

  # Contract list
  status=$(http_get "$STELLAR/contracts" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /contracts" "200" "$status"

  # Transaction history
  status=$(http_get "$STELLAR/transactions" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /transactions" "200" "$status"

  # Simulated payment (no key needed — simulation only)
  if [[ -n "$STELLAR_SECRET_KEY_TESTNET" ]]; then
    TASK_ID=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || uuidgen | tr '[:upper:]' '[:lower:]')
    status=$(http_post "$STELLAR/payment" \
      "{\"taskId\":\"$TASK_ID\",\"network\":\"testnet\",\"destination\":\"GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN\",\"amount\":\"1\",\"asset\":{\"code\":\"XLM\"},\"simulate\":true}" \
      "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
    assert_status "POST /payment (simulate XLM)" "200" "$status"
  fi
fi
if $RUN_AI && [[ -n "$AUTH_TOKEN" ]]; then
  echo ""
  echo -e "${BOLD}${CYAN}━━━ AI Pipeline Test ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

  # Quick task through gateway
  TASK_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
  status=$(http_post "$GATEWAY/run" \
    '{"instruction":"What is 2 + 2? Reply with only the number.","requiresAudit":false,"priority":"low"}' \
    "-H 'Authorization: Bearer $AUTH_TOKEN'")

  if [[ "$status" == "200" ]]; then
    assert_status "POST /run (AI task)" "200" "$status"
    OUTPUT=$(get_json_field "output")
    echo -e "  ${BLUE}ℹ️  AI output: $OUTPUT${RESET}"
  else
    assert_status "POST /run (AI task)" "200" "$status" "$(get_body)"
  fi

  # MCP tools list
  status=$(http_get "$GATEWAY/mcp/tools" "-H 'Authorization: Bearer $AUTH_TOKEN'")
  assert_status "GET /mcp/tools" "200" "$status"

  # System status
  status=$(http_get "$GATEWAY/status" "-H 'Authorization: Bearer $AUTH_TOKEN'")
  assert_status "GET /status" "200" "$status"
fi

# ── MCP TOOL TESTS ────────────────────────────────────────────
if $RUN_AI && [[ -n "$INTERNAL_TOKEN" ]]; then
  echo ""
  echo -e "${BOLD}${CYAN}━━━ MCP Tool Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

  TASK_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

  # Package lookup
  status=$(http_post "http://localhost:3005/call" \
    "{\"taskId\":\"$TASK_ID\",\"toolName\":\"package_lookup\",\"input\":{\"packageName\":\"fastify\"}}" \
    "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "MCP package_lookup (fastify)" "200" "$status"

  # Web fetch
  status=$(http_post "http://localhost:3005/call" \
    "{\"taskId\":\"$TASK_ID\",\"toolName\":\"web_fetch\",\"input\":{\"url\":\"https://httpbin.org/json\"}}" \
    "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  if [[ "$status" == "200" ]]; then
    assert_status "MCP web_fetch" "200" "$status"
  else
    echo -e "  ${YELLOW}⚠️  MCP web_fetch (network may be restricted)${RESET}"
    SKIP=$((SKIP + 1))
  fi

  # MCP metrics
  status=$(http_get "http://localhost:3005/metrics" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /metrics (mcp)" "200" "$status"
fi

# ── DATABASE TESTS ────────────────────────────────────────────
if $RUN_AI && [[ -n "$INTERNAL_TOKEN" ]]; then
  echo ""
  echo -e "${BOLD}${CYAN}━━━ Database Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

  status=$(http_get "$DB_SVC/stats" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /stats (database)" "200" "$status"

  status=$(http_get "$DB_SVC/tasks?limit=5" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /tasks (database)" "200" "$status"

  status=$(http_get "$DB_SVC/contracts?limit=5" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /contracts (database)" "200" "$status"

  status=$(http_get "$DB_SVC/events?limit=5" "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "GET /events (database)" "200" "$status"
fi

# ── EVENTS TESTS ──────────────────────────────────────────────
if $RUN_AI && [[ -n "$INTERNAL_TOKEN" ]]; then
  echo ""
  echo -e "${BOLD}${CYAN}━━━ Events Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

  # Emit event
  status=$(http_post "$EVENTS/emit" \
    '{"type":"system.recovered","source":"test","payload":{"test":true}}' \
    "-H 'x-aiops-service-token: $INTERNAL_TOKEN'")
  assert_status "POST /emit (event)" "202" "$status"

  # Connections
  status=$(http_get "$EVENTS/connections")
  assert_status "GET /connections" "200" "$status"

  # Metrics
  status=$(http_get "$EVENTS/metrics")
  assert_status "GET /metrics (events)" "200" "$status"
fi

# ── SUMMARY ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}━━━ Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
TOTAL=$((PASS + FAIL + SKIP))
echo -e "  Total:   $TOTAL"
echo -e "  ${GREEN}Passed:  $PASS${RESET}"
if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}Failed:  $FAIL${RESET}"
else
  echo -e "  Failed:  $FAIL"
fi
if [[ $SKIP -gt 0 ]]; then
  echo -e "  ${YELLOW}Skipped: $SKIP${RESET}"
fi
echo ""

if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}✅ All tests passed${RESET}"
  exit 0
else
  echo -e "${RED}${BOLD}❌ $FAIL test(s) failed${RESET}"
  exit 1
fi
