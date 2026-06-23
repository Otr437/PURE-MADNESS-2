#!/bin/bash

# Crypto Service Test Script

CRYPTO_URL="${CRYPTO_URL:-http://localhost:8081}"
COLOR_GREEN='\033[0;32m'
COLOR_RED='\033[0;31m'
COLOR_BLUE='\033[0;34m'
COLOR_NC='\033[0m'

echo "🔐 Crypto Service Test Suite"
echo "Testing service at: $CRYPTO_URL"
echo "================================"

test_count=0
passed=0
failed=0

run_test() {
    local name="$1"
    local command="$2"
    
    test_count=$((test_count + 1))
    echo -n "Test $test_count: $name... "
    
    response=$(eval "$command" 2>&1)
    status=$?
    
    if [ $status -eq 0 ]; then
        echo -e "${COLOR_GREEN}✓ PASSED${COLOR_NC}"
        passed=$((passed + 1))
    else
        echo -e "${COLOR_RED}✗ FAILED${COLOR_NC}"
        echo "  Error: $response"
        failed=$((failed + 1))
    fi
}

echo ""
echo "=== Health Check ==="

run_test "Service health" \
    "curl -sf $CRYPTO_URL/health > /dev/null"

run_test "List algorithms" \
    "curl -sf $CRYPTO_URL/algorithms > /dev/null"

echo ""
echo "=== AES-256-GCM Encryption ==="

# Encrypt
ENCRYPT_RESPONSE=$(curl -sf $CRYPTO_URL/encrypt \
    -H "Content-Type: application/json" \
    -d '{"data":"Hello, World!","algorithm":"aes-256-gcm"}')

ENCRYPTED=$(echo $ENCRYPT_RESPONSE | grep -o '"encrypted":"[^"]*"' | cut -d'"' -f4)
NONCE=$(echo $ENCRYPT_RESPONSE | grep -o '"nonce":"[^"]*"' | cut -d'"' -f4)

run_test "AES-256-GCM encryption" \
    "[ ! -z '$ENCRYPTED' ]"

echo ""
echo "=== Hashing ==="

run_test "SHA-256 hash" \
    "curl -sf $CRYPTO_URL/hash -H 'Content-Type: application/json' -d '{\"data\":\"test\",\"algorithm\":\"sha256\"}' | grep -q 'hash'"

run_test "SHA-512 hash" \
    "curl -sf $CRYPTO_URL/hash -H 'Content-Type: application/json' -d '{\"data\":\"test\",\"algorithm\":\"sha512\"}' | grep -q 'hash'"

run_test "BLAKE3 hash" \
    "curl -sf $CRYPTO_URL/hash -H 'Content-Type: application/json' -d '{\"data\":\"test\",\"algorithm\":\"blake3\"}' | grep -q 'hash'"

echo ""
echo "=== Password Hashing ==="

# Hash password
PASS_RESPONSE=$(curl -sf $CRYPTO_URL/password/hash \
    -H "Content-Type: application/json" \
    -d '{"password":"test_password","algorithm":"bcrypt"}')

HASH=$(echo $PASS_RESPONSE | grep -o '"hash":"[^"]*"' | cut -d'"' -f4)

run_test "bcrypt password hash" \
    "[ ! -z '$HASH' ]"

# Verify correct password
run_test "Verify correct password" \
    "curl -sf $CRYPTO_URL/password/verify -H 'Content-Type: application/json' -d '{\"password\":\"test_password\",\"hash\":\"$HASH\"}' | grep -q '\"valid\":true'"

# Verify wrong password
run_test "Reject wrong password" \
    "curl -sf $CRYPTO_URL/password/verify -H 'Content-Type: application/json' -d '{\"password\":\"wrong_password\",\"hash\":\"$HASH\"}' | grep -q '\"valid\":false'"

echo ""
echo "=== Key Management ==="

# Generate AES key
KEY_RESPONSE=$(curl -sf $CRYPTO_URL/keys/generate \
    -H "Content-Type: application/json" \
    -d '{"algorithm":"aes-256"}')

KEY_ID=$(echo $KEY_RESPONSE | grep -o '"key_id":"[^"]*"' | cut -d'"' -f4)

run_test "Generate AES key" \
    "[ ! -z '$KEY_ID' ]"

run_test "List keys" \
    "curl -sf $CRYPTO_URL/keys/list | grep -q '$KEY_ID'"

run_test "Get specific key" \
    "curl -sf $CRYPTO_URL/keys/$KEY_ID | grep -q '$KEY_ID'"

echo ""
echo "=== Ed25519 Signatures ==="

# Generate Ed25519 keypair
SIG_KEY_RESPONSE=$(curl -sf $CRYPTO_URL/keys/generate \
    -H "Content-Type: application/json" \
    -d '{"algorithm":"ed25519"}')

SIG_KEY_ID=$(echo $SIG_KEY_RESPONSE | grep -o '"key_id":"[^"]*"' | cut -d'"' -f4)
PUBLIC_KEY=$(echo $SIG_KEY_RESPONSE | grep -o '"public_key":"[^"]*"' | cut -d'"' -f4)

run_test "Generate Ed25519 keypair" \
    "[ ! -z '$SIG_KEY_ID' ]"

# Sign data
SIGN_RESPONSE=$(curl -sf $CRYPTO_URL/sign \
    -H "Content-Type: application/json" \
    -d "{\"data\":\"Important message\",\"key_id\":\"$SIG_KEY_ID\"}")

SIGNATURE=$(echo $SIGN_RESPONSE | grep -o '"signature":"[^"]*"' | cut -d'"' -f4)

run_test "Sign data with Ed25519" \
    "[ ! -z '$SIGNATURE' ]"

# Verify signature
run_test "Verify Ed25519 signature" \
    "curl -sf $CRYPTO_URL/verify -H 'Content-Type: application/json' -d '{\"data\":\"Important message\",\"signature\":\"$SIGNATURE\",\"public_key\":\"$PUBLIC_KEY\"}' | grep -q '\"valid\":true'"

# Verify with wrong data
run_test "Reject invalid signature" \
    "curl -sf $CRYPTO_URL/verify -H 'Content-Type: application/json' -d '{\"data\":\"Wrong message\",\"signature\":\"$SIGNATURE\",\"public_key\":\"$PUBLIC_KEY\"}' | grep -q '\"valid\":false'"

echo ""
echo "=== JWT Tokens ==="

# Create JWT
JWT_RESPONSE=$(curl -sf $CRYPTO_URL/jwt/create \
    -H "Content-Type: application/json" \
    -d '{"claims":{"user_id":123,"role":"admin"},"secret":"test_secret","expires_in":3600}')

TOKEN=$(echo $JWT_RESPONSE | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

run_test "Create JWT token" \
    "[ ! -z '$TOKEN' ]"

# Verify JWT
run_test "Verify JWT token" \
    "curl -sf $CRYPTO_URL/jwt/verify -H 'Content-Type: application/json' -d '{\"token\":\"$TOKEN\",\"secret\":\"test_secret\"}' | grep -q '\"valid\":true'"

# Verify with wrong secret
run_test "Reject JWT with wrong secret" \
    "curl -sf $CRYPTO_URL/jwt/verify -H 'Content-Type: application/json' -d '{\"token\":\"$TOKEN\",\"secret\":\"wrong_secret\"}' | grep -q '\"valid\":false'"

echo ""
echo "=== RSA Encryption ==="

# Generate RSA keypair
RSA_RESPONSE=$(curl -sf $CRYPTO_URL/keys/generate \
    -H "Content-Type: application/json" \
    -d '{"algorithm":"rsa-4096"}')

RSA_KEY_ID=$(echo $RSA_RESPONSE | grep -o '"key_id":"[^"]*"' | cut -d'"' -f4)

run_test "Generate RSA-4096 keypair" \
    "[ ! -z '$RSA_KEY_ID' ]"

echo ""
echo "=== ChaCha20-Poly1305 Encryption ==="

run_test "ChaCha20-Poly1305 encryption" \
    "curl -sf $CRYPTO_URL/encrypt -H 'Content-Type: application/json' -d '{\"data\":\"Test data\",\"algorithm\":\"chacha20-poly1305\"}' | grep -q 'encrypted'"

echo ""
echo "=== Argon2 Password Hashing ==="

ARGON2_RESPONSE=$(curl -sf $CRYPTO_URL/password/hash \
    -H "Content-Type: application/json" \
    -d '{"password":"secure_pass","algorithm":"argon2"}')

ARGON2_HASH=$(echo $ARGON2_RESPONSE | grep -o '"hash":"[^"]*"' | cut -d'"' -f4)

run_test "Argon2 password hash" \
    "[ ! -z '$ARGON2_HASH' ]"

run_test "Verify Argon2 password" \
    "curl -sf $CRYPTO_URL/password/verify -H 'Content-Type: application/json' -d '{\"password\":\"secure_pass\",\"hash\":\"$ARGON2_HASH\"}' | grep -q '\"valid\":true'"

echo ""
echo "=== Results ==="
echo "================================"
echo "Total Tests: $test_count"
echo -e "Passed: ${COLOR_GREEN}$passed${COLOR_NC}"
echo -e "Failed: ${COLOR_RED}$failed${COLOR_NC}"

if [ $failed -eq 0 ]; then
    echo -e "\n${COLOR_GREEN}🎉 All tests passed!${COLOR_NC}"
    exit 0
else
    echo -e "\n${COLOR_RED}⚠️  Some tests failed!${COLOR_NC}"
    exit 1
fi
