# WAF Microservice API Documentation

## Base URL
```
http://your-waf-server:8080
```

All admin endpoints are prefixed with `/waf/`. All other paths are proxied to backend services after WAF validation.

---

## Admin Endpoints

### Health Check

Check if the WAF is running and healthy.

**Endpoint:** `GET /waf/health`

**Response:**
```json
{
  "status": "healthy",
  "timestamp": 1706342400,
  "version": "1.0.0"
}
```

**Status Codes:**
- `200 OK`: Service is healthy

---

### Metrics

Get Prometheus-formatted metrics.

**Endpoint:** `GET /waf/metrics`

**Response:** Prometheus text format
```
# HELP waf_requests_total Total number of requests processed
# TYPE waf_requests_total counter
waf_requests_total 15234
# HELP waf_requests_blocked Number of requests blocked
# TYPE waf_requests_blocked counter
waf_requests_blocked 342
...
```

**Status Codes:**
- `200 OK`: Metrics returned

---

### Statistics

Get current WAF statistics.

**Endpoint:** `GET /waf/stats`

**Response:**
```json
{
  "blocked_ips_count": 42,
  "whitelist_count": 5,
  "timestamp": 1706342400
}
```

**Status Codes:**
- `200 OK`: Stats returned

---

### List Blocked IPs

Get all currently blocked IP addresses.

**Endpoint:** `GET /waf/blocked-ips`

**Response:**
```json
[
  {
    "ip": "192.168.1.100",
    "reason": "SQL injection attempt",
    "blocked_at": 1706342000,
    "unblock_at": 1706345600,
    "remaining_seconds": 3600,
    "block_count": 3
  },
  {
    "ip": "10.0.0.50",
    "reason": "Rate limit exceeded",
    "blocked_at": 1706342100,
    "unblock_at": 1706342400,
    "remaining_seconds": 300,
    "block_count": 1
  }
]
```

**Fields:**
- `ip`: IP address
- `reason`: Why it was blocked
- `blocked_at`: Unix timestamp when blocked
- `unblock_at`: Unix timestamp when it will be unblocked
- `remaining_seconds`: Seconds until automatic unblock
- `block_count`: Number of times this IP has been blocked

**Status Codes:**
- `200 OK`: List returned

---

### List Whitelist

Get all whitelisted IP addresses.

**Endpoint:** `GET /waf/whitelist`

**Response:**
```json
[
  {
    "ip": "10.0.0.5",
    "reason": "Internal monitoring service"
  },
  {
    "ip": "192.168.1.1",
    "reason": "Development machine"
  }
]
```

**Status Codes:**
- `200 OK`: List returned

---

### Add to Whitelist

Add an IP address to the whitelist. Whitelisted IPs bypass all WAF checks.

**Endpoint:** `POST /waf/whitelist`

**Request Body:**
```json
{
  "ip": "10.0.0.5",
  "reason": "Internal monitoring service"
}
```

**Fields:**
- `ip` (required): IP address to whitelist (IPv4 or IPv6)
- `reason` (required): Explanation for whitelisting

**Response:**
```json
{
  "success": true,
  "ip": "10.0.0.5",
  "reason": "Internal monitoring service"
}
```

**Status Codes:**
- `200 OK`: IP added to whitelist
- `400 Bad Request`: Invalid IP address

---

### List Custom Rules

Get all custom rules configured in the WAF.

**Endpoint:** `GET /waf/rules`

**Response:**
```json
[
  {
    "id": "block_admin_path",
    "name": "Block unauthorized admin access",
    "description": "Block access to /admin paths from non-whitelisted IPs",
    "enabled": true,
    "action": "block",
    "conditions": [
      {
        "field": {"path": null},
        "operator": "starts_with",
        "value": "/admin",
        "case_sensitive": false
      }
    ],
    "ban_duration": 300
  }
]
```

**Status Codes:**
- `200 OK`: Rules returned

---

### Update Custom Rules

Replace all custom rules with a new set.

**Endpoint:** `POST /waf/rules`

**Request Body:**
```json
{
  "rules": [
    {
      "id": "block_sensitive",
      "name": "Block Sensitive Paths",
      "description": "Prevent access to sensitive endpoints",
      "enabled": true,
      "action": "block",
      "conditions": [
        {
          "field": {"path": null},
          "operator": "regex",
          "value": "^/(admin|internal|private)",
          "case_sensitive": false
        }
      ],
      "ban_duration": 600
    }
  ]
}
```

**Rule Fields:**
- `id` (string): Unique identifier for the rule
- `name` (string): Human-readable name
- `description` (string): What the rule does
- `enabled` (boolean): Whether the rule is active
- `action` (string): `"block"`, `"log"`, or `"challenge"`
- `conditions` (array): Conditions that must ALL match
- `ban_duration` (number): Seconds to ban IP if rule triggers

**Condition Fields:**
- `field`: What to check
  - `{"method": null}`: HTTP method (GET, POST, etc.)
  - `{"path": null}`: URL path
  - `{"query": null}`: Query string
  - `{"header": "X-Custom-Header"}`: Specific header
  - `{"body": null}`: Request body
  - `{"user_agent": null}`: User-Agent header
- `operator`: How to compare
  - `"equals"`: Exact match
  - `"not_equals"`: Not equal
  - `"contains"`: Contains substring
  - `"not_contains"`: Doesn't contain
  - `"starts_with"`: Starts with
  - `"ends_with"`: Ends with
  - `"regex"`: Regular expression match
  - `"length_greater"`: Length exceeds value
  - `"length_less"`: Length is less than value
- `value` (string): Value to compare against
- `case_sensitive` (boolean): Case-sensitive comparison

**Response:**
```json
{
  "success": true
}
```

**Status Codes:**
- `200 OK`: Rules updated
- `400 Bad Request`: Invalid rule format

---

### Get Attack Logs

Retrieve recent attack attempts.

**Endpoint:** `GET /waf/attack-logs`

**Response:**
```json
[
  {
    "id": 1,
    "timestamp": "1706342400",
    "ip_address": "192.168.1.100",
    "attack_type": "SqlInjection",
    "severity": "Critical",
    "method": "GET",
    "path": "/api/users",
    "user_agent": "curl/7.68.0",
    "blocked": true,
    "details": "SQL injection pattern detected: union select"
  },
  {
    "id": 2,
    "timestamp": "1706342350",
    "ip_address": "10.0.0.50",
    "attack_type": "Xss",
    "severity": "Critical",
    "method": "POST",
    "path": "/api/comment",
    "user_agent": "Mozilla/5.0",
    "blocked": true,
    "details": "XSS pattern detected: <script>"
  }
]
```

**Attack Types:**
- `SqlInjection`: SQL injection attempt
- `Xss`: Cross-site scripting
- `PathTraversal`: Directory traversal
- `CommandInjection`: OS command injection
- `Xxe`: XML external entity
- `Ssrf`: Server-side request forgery
- `RateLimitExceeded`: Too many requests
- `BruteForce`: Login brute force attempt
- `InvalidInput`: Custom rule violation
- `MaliciousBot`: Malicious bot detected
- `SuspiciousHeaders`: Suspicious HTTP headers
- `LargePayload`: Request too large
- `MaliciousFile`: Malicious file upload

**Severity Levels:**
- `Critical`: Immediate threat
- `High`: Serious attack attempt
- `Medium`: Suspicious activity
- `Low`: Minor violation
- `Info`: Informational

**Status Codes:**
- `200 OK`: Logs returned
- `500 Internal Server Error`: Database error

---

### Clear All Blocks

Remove all temporary IP blocks.

**Endpoint:** `POST /waf/clear-blocks`

**Response:**
```json
{
  "success": true,
  "message": "All temporary blocks cleared"
}
```

**Status Codes:**
- `200 OK`: Blocks cleared

---

## Custom Rule Examples

### Block Specific File Extensions

```json
{
  "id": "block_php",
  "name": "Block PHP Files",
  "description": "Prevent access to PHP files",
  "enabled": true,
  "action": "block",
  "conditions": [
    {
      "field": {"path": null},
      "operator": "ends_with",
      "value": ".php",
      "case_sensitive": false
    }
  ],
  "ban_duration": 600
}
```

### Block by User Agent

```json
{
  "id": "block_scanners",
  "name": "Block Security Scanners",
  "description": "Block known scanning tools",
  "enabled": true,
  "action": "block",
  "conditions": [
    {
      "field": {"user_agent": null},
      "operator": "regex",
      "value": "(?i)(sqlmap|nikto|nmap|masscan|nessus|burp)",
      "case_sensitive": false
    }
  ],
  "ban_duration": 3600
}
```

### Rate Limit Specific Endpoint

```json
{
  "id": "limit_api",
  "name": "API Rate Limit",
  "description": "Extra strict rate limiting for API",
  "enabled": true,
  "action": "block",
  "conditions": [
    {
      "field": {"path": null},
      "operator": "starts_with",
      "value": "/api/",
      "case_sensitive": false
    }
  ],
  "ban_duration": 60
}
```

### Block Requests with Large Body

```json
{
  "id": "block_large_body",
  "name": "Block Large Body",
  "description": "Prevent large request bodies",
  "enabled": true,
  "action": "block",
  "conditions": [
    {
      "field": {"body": null},
      "operator": "length_greater",
      "value": "1048576",
      "case_sensitive": false
    }
  ],
  "ban_duration": 300
}
```

### Block Multiple Conditions (AND)

```json
{
  "id": "block_admin_post",
  "name": "Block Admin POST",
  "description": "Block POST requests to admin area",
  "enabled": true,
  "action": "block",
  "conditions": [
    {
      "field": {"method": null},
      "operator": "equals",
      "value": "POST",
      "case_sensitive": false
    },
    {
      "field": {"path": null},
      "operator": "starts_with",
      "value": "/admin",
      "case_sensitive": false
    }
  ],
  "ban_duration": 900
}
```

---

## Error Responses

### 400 Bad Request
Invalid request format or parameters.
```json
{
  "error": "Invalid IP address"
}
```

### 403 Forbidden
Request blocked by WAF.

### 429 Too Many Requests
Rate limit exceeded.

### 500 Internal Server Error
Database or server error.
```json
{
  "error": "Database error"
}
```

---

## Rate Limiting

All IPs are subject to rate limiting (configurable in `config.toml`):

- Default: 100 requests per 60 seconds
- Exceeding the limit results in a 5-minute ban (default)
- Whitelisted IPs bypass rate limiting

**Headers (planned):**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1706342460
```

---

## Integration Examples

### cURL

```bash
# Get stats
curl http://localhost:8080/waf/stats

# Add whitelist
curl -X POST http://localhost:8080/waf/whitelist \
  -H "Content-Type: application/json" \
  -d '{"ip": "10.0.0.5", "reason": "Trusted"}'

# Update rules
curl -X POST http://localhost:8080/waf/rules \
  -H "Content-Type: application/json" \
  -d @rules.json
```

### Python

```python
import requests

# Get blocked IPs
response = requests.get('http://localhost:8080/waf/blocked-ips')
blocked_ips = response.json()
print(f"Blocked IPs: {len(blocked_ips)}")

# Add to whitelist
requests.post('http://localhost:8080/waf/whitelist', json={
    'ip': '10.0.0.5',
    'reason': 'Development machine'
})
```

### JavaScript (Node.js)

```javascript
const axios = require('axios');

// Get attack logs
async function getAttackLogs() {
  const response = await axios.get('http://localhost:8080/waf/attack-logs');
  console.log(`Recent attacks: ${response.data.length}`);
  return response.data;
}

// Clear blocks
async function clearBlocks() {
  await axios.post('http://localhost:8080/waf/clear-blocks');
  console.log('All blocks cleared');
}
```

---

## Prometheus Metrics Reference

| Metric | Type | Description |
|--------|------|-------------|
| `waf_requests_total` | Counter | Total requests processed |
| `waf_requests_allowed` | Counter | Requests allowed through |
| `waf_requests_blocked` | Counter | Requests blocked |
| `waf_sql_injection_blocked` | Counter | SQL injections blocked |
| `waf_xss_blocked` | Counter | XSS attacks blocked |
| `waf_path_traversal_blocked` | Counter | Path traversals blocked |
| `waf_command_injection_blocked` | Counter | Command injections blocked |
| `waf_xxe_blocked` | Counter | XXE attacks blocked |
| `waf_ssrf_blocked` | Counter | SSRF attacks blocked |
| `waf_rate_limits_triggered` | Counter | Rate limit violations |
| `waf_custom_rules_triggered` | Counter | Custom rule matches |
| `waf_response_time_seconds` | Histogram | Response time distribution |
| `waf_active_blocks` | Gauge | Currently blocked IPs |

---

## Best Practices

1. **Whitelist Your IPs**: Add development and monitoring IPs to whitelist
2. **Start with Log Mode**: Test rules in "log" mode before switching to "block"
3. **Monitor False Positives**: Review attack logs regularly
4. **Incremental Rules**: Add custom rules gradually
5. **Regular Backups**: Back up the SQLite database
6. **Rate Limit Tuning**: Adjust based on legitimate traffic patterns
7. **Use Specific Rules**: Target specific paths/patterns rather than broad rules

---

## Support

For issues or questions:
- GitHub Issues: <repo-url>/issues
- Documentation: README.md
- Examples: examples/ directory
