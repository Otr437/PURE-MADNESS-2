# WAF Microservice - Production-Ready Web Application Firewall

A high-performance, production-ready Web Application Firewall (WAF) built in Rust. Protects your applications from common web attacks including SQL injection, XSS, path traversal, command injection, and more.

## 🚀 Features

### Core Protection
- ✅ **SQL Injection Detection** - Comprehensive pattern matching for SQL injection attempts
- ✅ **XSS (Cross-Site Scripting)** - Detects and blocks malicious scripts
- ✅ **Path Traversal** - Prevents directory traversal attacks
- ✅ **Command Injection** - Blocks OS command injection attempts
- ✅ **XXE (XML External Entity)** - Protects against XXE attacks
- ✅ **SSRF (Server-Side Request Forgery)** - Blocks internal network access attempts

### Rate Limiting & Abuse Prevention
- ✅ **Advanced Rate Limiting** - Per-IP request throttling
- ✅ **Brute Force Protection** - Login attempt monitoring
- ✅ **Automatic IP Blocking** - Temporary bans for malicious IPs
- ✅ **Whitelist Support** - Bypass protection for trusted IPs

### Custom Rules Engine
- ✅ **Flexible Rule System** - Create custom detection rules
- ✅ **Multiple Conditions** - Combine conditions with AND logic
- ✅ **Regex Support** - Use regular expressions in rules
- ✅ **Hot Reload** - Update rules without restart

### Monitoring & Logging
- ✅ **Prometheus Metrics** - Complete metrics export
- ✅ **Attack Logging** - Detailed attack logs in SQLite
- ✅ **JSON Logging** - Structured logging for easy parsing
- ✅ **Real-time Stats** - Live attack statistics API

### Performance
- ✅ **Built with Rust** - Memory-safe and blazing fast
- ✅ **Async/Await** - Tokio-based async runtime
- ✅ **Low Latency** - Sub-millisecond overhead
- ✅ **Horizontally Scalable** - Stateless design

## 📋 Requirements

- Rust 1.75+ (for building from source)
- Docker & Docker Compose (for containerized deployment)

## 🔧 Installation

### Option 1: Docker (Recommended)

```bash
# Clone the repository
git clone <your-repo>
cd waf-microservice

# Start with Docker Compose (includes Prometheus + Grafana)
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f waf
```

### Option 2: Build from Source

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Clone and build
git clone <your-repo>
cd waf-microservice
cargo build --release

# Run
./target/release/waf-microservice
```

## ⚙️ Configuration

Edit `config.toml` to customize settings:

```toml
# Server Settings
port = 8080
workers = 4

# Rate Limiting
rate_limit_requests = 100  # requests per window
rate_limit_window = 60  # seconds
rate_limit_ban_duration = 300  # 5 minutes

# Request Limits
max_request_size = 10485760  # 10MB
max_url_length = 2048

# Attack Response
attack_ban_duration = 3600  # 1 hour

# Backend Services
[[backends]]
name = "api"
url = "http://localhost:3000"
path_prefix = "/api"
```

## 🎯 Usage

### As a Reverse Proxy

Configure your backend services in `config.toml` and the WAF will automatically proxy requests after validation:

```toml
[[backends]]
name = "myapp"
url = "http://localhost:3000"
path_prefix = "/"
```

### With NGINX

```nginx
upstream waf {
    server 127.0.0.1:8080;
}

server {
    listen 80;
    server_name example.com;
    
    location / {
        proxy_pass http://waf;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### With Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: waf
spec:
  replicas: 3
  selector:
    matchLabels:
      app: waf
  template:
    metadata:
      labels:
        app: waf
    spec:
      containers:
      - name: waf
        image: your-registry/waf-microservice:latest
        ports:
        - containerPort: 8080
        env:
        - name: RUST_LOG
          value: "info"
---
apiVersion: v1
kind: Service
metadata:
  name: waf
spec:
  selector:
    app: waf
  ports:
  - port: 80
    targetPort: 8080
```

## 📊 API Endpoints

### Admin Endpoints

#### Health Check
```bash
GET /waf/health
```
Response:
```json
{
  "status": "healthy",
  "timestamp": 1706342400,
  "version": "1.0.0"
}
```

#### Prometheus Metrics
```bash
GET /waf/metrics
```
Returns Prometheus-formatted metrics

#### Statistics
```bash
GET /waf/stats
```
Response:
```json
{
  "blocked_ips_count": 42,
  "whitelist_count": 5,
  "timestamp": 1706342400
}
```

#### Blocked IPs
```bash
GET /waf/blocked-ips
```
Response:
```json
[
  {
    "ip": "192.168.1.100",
    "reason": "SQL injection attempt",
    "blocked_at": 1706342000,
    "unblock_at": 1706345600,
    "remaining_seconds": 3600,
    "block_count": 3
  }
]
```

#### Whitelist Management
```bash
# List whitelist
GET /waf/whitelist

# Add to whitelist
POST /waf/whitelist
Content-Type: application/json

{
  "ip": "10.0.0.5",
  "reason": "Internal monitoring service"
}
```

#### Custom Rules
```bash
# List rules
GET /waf/rules

# Update rules
POST /waf/rules
Content-Type: application/json

{
  "rules": [
    {
      "id": "block_sensitive_path",
      "name": "Block Sensitive Path",
      "description": "Block access to sensitive endpoints",
      "enabled": true,
      "action": "block",
      "conditions": [
        {
          "field": {"path": null},
          "operator": "starts_with",
          "value": "/internal",
          "case_sensitive": false
        }
      ],
      "ban_duration": 600
    }
  ]
}
```

#### Attack Logs
```bash
GET /waf/attack-logs
```
Returns the last 100 attack attempts

#### Clear Blocks
```bash
POST /waf/clear-blocks
```
Removes all temporary IP blocks

## 🛡️ Protection Details

### SQL Injection
Detects patterns including:
- `UNION SELECT`
- `INSERT INTO`
- `DROP TABLE`
- Hex-encoded attacks
- Boolean-based blind SQL injection
- Time-based blind SQL injection
- And 15+ more patterns

### XSS Protection
Blocks:
- `<script>` tags
- Event handlers (`onload`, `onerror`, etc.)
- `javascript:` protocol
- `data:` URLs
- `<iframe>`, `<object>`, `<embed>` tags
- And 20+ more variations

### Path Traversal
Detects:
- `../` sequences
- URL-encoded variations (`%2e%2e/`)
- Windows paths (`..\\`)
- `/etc/passwd` attempts
- NULL byte injection

### Command Injection
Blocks:
- Shell metacharacters (`;`, `|`, `&&`, etc.)
- Command chaining
- Common shell commands (`cat`, `wget`, `nc`, etc.)
- `/dev/tcp` exploitation
- `eval()` and `exec()` calls

## 📈 Monitoring

### Prometheus Metrics

Available metrics:
- `waf_requests_total` - Total requests processed
- `waf_requests_allowed` - Requests allowed through
- `waf_requests_blocked` - Requests blocked
- `waf_sql_injection_blocked` - SQL injections blocked
- `waf_xss_blocked` - XSS attacks blocked
- `waf_path_traversal_blocked` - Path traversals blocked
- `waf_command_injection_blocked` - Command injections blocked
- `waf_rate_limits_triggered` - Rate limit violations
- `waf_custom_rules_triggered` - Custom rule matches
- `waf_response_time_seconds` - Response time histogram
- `waf_active_blocks` - Currently blocked IPs

### Grafana Dashboard

Access Grafana at `http://localhost:3001` (default credentials: admin/admin)

Import the included dashboard to visualize:
- Request rates
- Attack types distribution
- Blocked IPs over time
- Response time percentiles
- Top attacking IPs

## 🔒 Security Best Practices

1. **Run Behind a Proxy**: Use NGINX or a load balancer in front of the WAF
2. **Enable TLS**: Always use HTTPS in production
3. **Regular Updates**: Keep the WAF and its dependencies updated
4. **Monitor Logs**: Regularly review attack logs for patterns
5. **Whitelist Known IPs**: Add your monitoring systems to whitelist
6. **Tune Rules**: Adjust rules based on false positives
7. **Database Backups**: Regularly backup the SQLite database

## 🧪 Testing

### Unit Tests
```bash
cargo test
```

### Integration Tests
```bash
# SQL Injection
curl -X GET "http://localhost:8080/api/users?id=1' OR '1'='1"

# XSS
curl -X POST http://localhost:8080/api/comment \
  -H "Content-Type: application/json" \
  -d '{"text":"<script>alert(1)</script>"}'

# Path Traversal
curl "http://localhost:8080/file?path=../../etc/passwd"

# Rate Limiting
for i in {1..150}; do curl http://localhost:8080/api/test; done
```

### Load Testing
```bash
# Using Apache Bench
ab -n 10000 -c 100 http://localhost:8080/

# Using wrk
wrk -t12 -c400 -d30s http://localhost:8080/
```

## 📝 Custom Rules Examples

### Block Specific User Agents
```json
{
  "id": "block_bad_bots",
  "name": "Block Malicious Bots",
  "description": "Block known scanning tools",
  "enabled": true,
  "action": "block",
  "conditions": [
    {
      "field": {"user_agent": null},
      "operator": "regex",
      "value": "(?i)(sqlmap|nikto|nmap|masscan)",
      "case_sensitive": false
    }
  ],
  "ban_duration": 3600
}
```

### Block Large Query Strings
```json
{
  "id": "block_large_query",
  "name": "Block Large Query Strings",
  "description": "Prevent query string overflow attacks",
  "enabled": true,
  "action": "block",
  "conditions": [
    {
      "field": {"query": null},
      "operator": "length_greater",
      "value": "2048",
      "case_sensitive": false
    }
  ],
  "ban_duration": 600
}
```

### Block Specific Countries (with GeoIP)
```json
{
  "id": "geo_block",
  "name": "Geographic Blocking",
  "description": "Block traffic from specific countries",
  "enabled": false,
  "action": "block",
  "conditions": [
    {
      "field": {"ip_address": null},
      "operator": "regex",
      "value": "^(CN|RU|KP)$",
      "case_sensitive": false
    }
  ],
  "ban_duration": 86400
}
```

## 🐛 Troubleshooting

### High False Positive Rate
- Review `/waf/attack-logs` to identify problematic rules
- Whitelist legitimate IPs
- Adjust custom rules to be less aggressive
- Disable specific detection patterns if needed

### Performance Issues
- Increase `workers` in config.toml
- Enable horizontal scaling (multiple instances)
- Review database size and rotate old logs
- Optimize custom regex rules

### Database Locked Errors
- Ensure only one WAF instance per database
- Use separate databases for multiple instances
- Consider PostgreSQL for multi-instance deployments

## 📚 Architecture

```
┌──────────────┐
│   Client     │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────┐
│     WAF Middleware               │
│  ┌──────────────────────────┐   │
│  │ Rate Limiter             │   │
│  │ IP Whitelist/Blacklist   │   │
│  │ Attack Detection         │   │
│  │ Custom Rules Engine      │   │
│  │ Request Size Validation  │   │
│  └──────────────────────────┘   │
└──────────┬───────────────────────┘
           │
           ▼
    ┌──────────────┐
    │   Backend    │
    │   Services   │
    └──────────────┘
```

## 🤝 Contributing

Contributions welcome! Areas for improvement:
- Additional attack patterns
- Performance optimizations
- Better GeoIP integration
- Machine learning-based detection
- More comprehensive testing

## 📄 License

Apache 2.0 License - See LICENSE file

## 🔗 Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Cloudflare WAF](https://blog.cloudflare.com/new-cloudflare-waf/)
- [ModSecurity](https://github.com/SpiderLabs/ModSecurity)
- [Pingora](https://github.com/cloudflare/pingora)

## 📞 Support

- Issues: GitHub Issues
- Security: Report vulnerabilities via private disclosure

---

Built with ❤️ in Rust for maximum performance and security.
