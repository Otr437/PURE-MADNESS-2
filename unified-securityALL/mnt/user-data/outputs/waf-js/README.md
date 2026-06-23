# WAF Microservice - JavaScript/Node.js

A **production-ready Web Application Firewall (WAF)** built with modern JavaScript (Node.js 22+) and Fastify. Protects your web applications from OWASP Top 10 attacks with high performance and low latency.

## 🚀 Features

### Core Protection
- ✅ **SQL Injection** - 25+ patterns including UNION, blind SQLi, time-based
- ✅ **XSS (Cross-Site Scripting)** - 40+ patterns covering all XSS types
- ✅ **Path Traversal** - Directory traversal and file inclusion attacks
- ✅ **Command Injection** - OS command injection detection
- ✅ **XXE** - XML External Entity attacks
- ✅ **SSRF** - Server-Side Request Forgery prevention

### Rate Limiting & Protection
- ✅ **Per-IP Rate Limiting** - Built-in Fastify rate limiting
- ✅ **Automatic IP Blocking** - Temporary bans for attackers
- ✅ **Whitelist Support** - Bypass protection for trusted IPs
- ✅ **Custom Rules Engine** - Create your own detection rules

### Monitoring & Logging
- ✅ **Prometheus Metrics** - Full metrics export
- ✅ **SQLite Logging** - All attacks logged
- ✅ **Colored Console Logs** - Easy development debugging
- ✅ **Admin API** - Manage WAF via REST API

### Performance
- ✅ **Fastify Framework** - One of the fastest Node.js frameworks
- ✅ **< 2ms Overhead** - Minimal performance impact
- ✅ **Async/Await** - Non-blocking I/O
- ✅ **Better-SQLite3** - Fast synchronous database

## 📋 Requirements

- Node.js 22+ (uses native test runner and latest features)
- npm or pnpm
- Docker & Docker Compose (optional)

## 🔧 Installation

### Option 1: Docker (Recommended)

```bash
# Clone and start
git clone <repo>
cd waf-js
docker-compose up -d

# View logs
docker-compose logs -f waf

# Check status
curl http://localhost:8080/waf/health
```

### Option 2: Local Development

```bash
# Install Node.js 22+ (if needed)
nvm install 22
nvm use 22

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start in development mode
npm run dev

# Or production mode
npm start
```

## ⚙️ Configuration

Edit `.env` file:

```bash
# Server
HOST=0.0.0.0
PORT=8080

# Rate Limiting
RATE_LIMIT_REQUESTS=100   # requests per window
RATE_LIMIT_WINDOW=60      # seconds
RATE_LIMIT_BAN=300        # ban duration in seconds

# Attack Response
ATTACK_BAN_DURATION=3600  # 1 hour

# Features
ENABLE_RATE_LIMITING=true
```

## 🎯 Usage

### Quick Test

```bash
# Health check
curl http://localhost:8080/waf/health

# Try SQL injection (will be blocked)
curl "http://localhost:8080/api/test?id=1' OR '1'='1"

# Normal request (will pass)
curl "http://localhost:8080/api/test?id=123"
```

### View Statistics

```bash
# Get stats
curl http://localhost:8080/waf/stats

# See blocked IPs
curl http://localhost:8080/waf/blocked-ips

# View attack logs
curl http://localhost:8080/waf/attack-logs
```

### Whitelist Management

```bash
# Add IP to whitelist
curl -X POST http://localhost:8080/waf/whitelist \
  -H "Content-Type: application/json" \
  -d '{"ip": "10.0.0.5", "reason": "Internal server"}'

# List whitelist
curl http://localhost:8080/waf/whitelist

# Remove from whitelist
curl -X DELETE http://localhost:8080/waf/whitelist/10.0.0.5
```

### Block Management

```bash
# Manually block IP
curl -X POST http://localhost:8080/waf/block-ip \
  -H "Content-Type: application/json" \
  -d '{"ip": "192.168.1.100", "reason": "Manual block", "duration": 3600}'

# Unblock IP
curl -X DELETE http://localhost:8080/waf/blocked-ips/192.168.1.100

# Clear all blocks
curl -X POST http://localhost:8080/waf/clear-blocks
```

## 📊 API Endpoints

### Admin Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/waf/health` | Health check |
| GET | `/waf/metrics` | Prometheus metrics |
| GET | `/waf/stats` | Statistics |
| GET | `/waf/blocked-ips` | List blocked IPs |
| GET | `/waf/whitelist` | List whitelisted IPs |
| POST | `/waf/whitelist` | Add to whitelist |
| DELETE | `/waf/whitelist/:ip` | Remove from whitelist |
| GET | `/waf/attack-logs` | Recent attacks |
| GET | `/waf/rules` | List custom rules |
| POST | `/waf/rules` | Update rules |
| POST | `/waf/block-ip` | Manually block IP |
| DELETE | `/waf/blocked-ips/:ip` | Unblock IP |
| POST | `/waf/clear-blocks` | Clear all blocks |

## 🛡️ Protection Details

### SQL Injection
Blocks:
- UNION SELECT attacks
- Boolean-based blind SQLi
- Time-based blind SQLi (SLEEP, WAITFOR)
- Stacked queries
- Encoded attacks (%27, --, etc.)
- Database-specific attacks (xp_cmdshell, load_file, etc.)

### XSS Protection
Detects:
- Script tags (`<script>`, `<iframe>`)
- Event handlers (`onload`, `onerror`, etc.)
- JavaScript protocol
- Data URLs
- CSS expression()
- Base64 encoded attacks
- Unicode encoded attacks

### Command Injection
Prevents:
- Shell metacharacters (`;`, `|`, `&&`, etc.)
- Command substitution (`$()`, backticks)
- Common commands (`cat`, `wget`, `nc`, etc.)
- /dev/tcp exploitation

## 📈 Monitoring

### Prometheus Metrics

Available at `http://localhost:8080/waf/metrics`:

- `waf_requests_total` - Total requests
- `waf_requests_allowed` - Allowed requests
- `waf_requests_blocked` - Blocked requests
- `waf_sql_injection_blocked` - SQL injections blocked
- `waf_xss_blocked` - XSS attacks blocked
- `waf_path_traversal_blocked` - Path traversals blocked
- `waf_command_injection_blocked` - Command injections blocked
- `waf_response_time_seconds` - Response time histogram

### Grafana Dashboard

1. Access Grafana at `http://localhost:3001`
2. Login: admin/admin
3. Add Prometheus datasource: `http://prometheus:9090`
4. Create dashboard using the metrics above

## 🧪 Testing

### Run Tests

```bash
npm test
```

### Manual Testing

```bash
# SQL Injection
curl "http://localhost:8080/api?id=1' OR '1'='1"

# XSS
curl -X POST http://localhost:8080/api/comment \
  -H "Content-Type: application/json" \
  -d '{"text":"<script>alert(1)</script>"}'

# Path Traversal
curl "http://localhost:8080/file?path=../../etc/passwd"

# Command Injection
curl "http://localhost:8080/ping?host=127.0.0.1;cat /etc/passwd"
```

## 🚢 Deployment

### Docker Production

```bash
docker build -t waf-js:production .
docker run -d \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  -e NODE_ENV=production \
  --name waf \
  waf-js:production
```

### PM2 (Process Manager)

```bash
npm install -g pm2

pm2 start src/index.js --name waf -i max
pm2 save
pm2 startup
```

### Behind NGINX

```nginx
upstream waf {
    server 127.0.0.1:8080;
}

server {
    listen 80;
    server_name example.com;
    
    location / {
        proxy_pass http://waf;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Kubernetes

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
        image: waf-js:latest
        ports:
        - containerPort: 8080
        env:
        - name: NODE_ENV
          value: "production"
        - name: RATE_LIMIT_REQUESTS
          value: "100"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
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

## 📝 Custom Rules

### Example: Block Specific User Agents

```bash
curl -X POST http://localhost:8080/waf/rules \
  -H "Content-Type: application/json" \
  -d '{
  "rules": [
    {
      "id": "block_scanners",
      "name": "Block Security Scanners",
      "description": "Block known scanning tools",
      "enabled": true,
      "action": "block",
      "conditions": [
        {
          "field": "user_agent",
          "operator": "regex",
          "value": "(sqlmap|nikto|nmap)",
          "caseSensitive": false
        }
      ],
      "banDuration": 3600
    }
  ]
}'
```

### Example: Rate Limit API Endpoint

```json
{
  "id": "limit_api",
  "name": "API Rate Limit",
  "description": "Strict limits for API",
  "enabled": true,
  "action": "block",
  "conditions": [
    {
      "field": "path",
      "operator": "starts_with",
      "value": "/api/",
      "caseSensitive": false
    }
  ],
  "banDuration": 60
}
```

## 🐛 Troubleshooting

### Port Already in Use

```bash
# Change port in .env
PORT=8081

# Or kill existing process
lsof -ti:8080 | xargs kill -9
```

### Database Locked

```bash
# Stop all instances
pm2 stop all
# OR
docker-compose down

# Remove lock file
rm data/waf.db-shm data/waf.db-wal
```

### High CPU Usage

```bash
# Check rate limit settings
# Reduce RATE_LIMIT_REQUESTS if needed

# Enable clustering with PM2
pm2 start src/index.js -i max
```

## 🔒 Security Best Practices

1. **Always use HTTPS** in production
2. **Whitelist your IPs** for development/monitoring
3. **Tune rate limits** based on your traffic
4. **Regularly review logs** for false positives
5. **Keep dependencies updated** (`npm audit`)
6. **Run behind a load balancer** for production
7. **Set up alerting** with Prometheus Alertmanager

## 📊 Performance

Expected performance on 4-core system:

- **Throughput**: 20,000+ req/sec (clean requests)
- **Latency**: < 1ms overhead
- **Memory**: ~100MB base + 5KB per tracked IP
- **CPU**: ~40% at 10K req/sec

## 🤝 Contributing

Contributions welcome! Areas for improvement:

- Machine learning-based detection
- Redis support for distributed rate limiting
- GeoIP blocking
- More attack patterns
- Better test coverage

## 📄 License

Apache 2.0 - Free for commercial use

## 🎉 Why JavaScript/Node.js?

- ✅ **Fast Development**: Rapid prototyping and iteration
- ✅ **Large Ecosystem**: npm has packages for everything
- ✅ **Easy Deployment**: Runs anywhere Node runs
- ✅ **Great Performance**: Fastify is benchmarked at 50K+ req/sec
- ✅ **Modern**: Uses latest JS features (ES modules, async/await)
- ✅ **Popular**: Most developers know JavaScript

---

Built with ❤️ using Node.js 22, Fastify, and Better-SQLite3.
