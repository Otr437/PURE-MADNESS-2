#!/usr/bin/env bash
# scripts/registerAgent.sh
# Registers the bot as an agent identity in authorized-to-act's database.
# Run AFTER generating keys (npm run keygen) and before starting the bot.
# Requires: ATA_API_URL, ATA_ADMIN_TOKEN, AGENT_ID, AGENT_NAME set in env.

set -euo pipefail

source .env 2>/dev/null || true

: "${ATA_API_URL:?ATA_API_URL is required}"
: "${ATA_ADMIN_TOKEN:?ATA_ADMIN_TOKEN is required (admin Auth0 token)}"
: "${AGENT_ID:?AGENT_ID is required}"
: "${AGENT_NAME:?AGENT_NAME is required}"
: "${AGENT_PUBLIC_KEY_PATH:=./crypto/keys/agent_public.pem}"

if [ ! -f "$AGENT_PUBLIC_KEY_PATH" ]; then
  echo "ERROR: Public key not found at $AGENT_PUBLIC_KEY_PATH"
  echo "Run 'npm run keygen' first."
  exit 1
fi

PUBLIC_KEY_PEM=$(cat "$AGENT_PUBLIC_KEY_PATH")
BOT_JWKS_URL="${BOT_JWKS_URL:-http://localhost:${PORT:-4000}/.well-known/jwks.json}"

echo "Registering agent $AGENT_ID with authorized-to-act at $ATA_API_URL..."

PAYLOAD=$(jq -n \
  --arg agent_id    "$AGENT_ID" \
  --arg agent_name  "$AGENT_NAME" \
  --arg jwks_url    "$BOT_JWKS_URL" \
  --arg public_key  "$PUBLIC_KEY_PEM" \
  '{
    userId:      $agent_id,
    agentId:     $agent_id,
    agentName:   $agent_name,
    isAgent:     true,
    jwksUrl:     $jwks_url,
    publicKey:   $public_key,
    permissions: ["send:crypto", "swap:tokens", "nft:write"],
    roles:       ["agent"]
  }')

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$ATA_API_URL/api/admin/agents/register" \
  -H "Authorization: Bearer $ATA_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" -eq 200 ] || [ "$HTTP_CODE" -eq 201 ]; then
  echo "Agent registered successfully."
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
else
  echo "ERROR: Registration failed (HTTP $HTTP_CODE)"
  echo "$BODY"
  exit 1
fi
